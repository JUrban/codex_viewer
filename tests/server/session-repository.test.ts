import { appendFile, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexSessionRepository,
} from "../../src/server/create-session-repository.js";
import type {
  SessionSource,
  SourceSessionEntry,
} from "../../src/server/source/session-source.js";
import {
  DefaultSessionRepository,
  MAX_ITEM_PAGE_BYTES,
  RepositoryQueryError,
} from "../../src/server/repository/session-repository.js";
import { searchDocuments } from "../../src/server/search/search-document.js";
import type {
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

async function fixtureRepository() {
  const home = await createTempDirectory("codex-repository-");
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  return { home, repository: await createCodexSessionRepository(home) };
}

describe("DefaultSessionRepository", () => {
  it("coalesces concurrent refreshes, reuses a fresh snapshot, and permits a forced refresh", async () => {
    let discoveries = 0;
    let now = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const source: SessionSource = {
      descriptor: {
        sourceType: "test",
        instanceKey: "test",
        sourceInstanceId: "test",
        displayName: "Test",
      },
      async refresh() {
        discoveries += 1;
        await gate;
        return { signature: "empty", sessions: [], diagnostics: [] };
      },
    };
    const repository = new DefaultSessionRepository(
      [source],
      undefined,
      undefined,
      () => now,
    );

    const firstList = repository.list({});
    const secondList = repository.list({});
    release();
    expect((await firstList).listRevision).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await secondList).sessions).toEqual([]);
    expect(discoveries).toBe(1);
    await repository.list({});
    expect(discoveries).toBe(1);
    now = 1_999;
    await repository.list({});
    expect(discoveries).toBe(1);
    now = 2_000;
    await repository.list({});
    expect(discoveries).toBe(2);
    await expect(repository.refresh()).resolves.toBeUndefined();
    expect(discoveries).toBe(3);
  });

  it("keeps the list revision stable when only source diagnostics change", async () => {
    let signature = "warning";
    let diagnostics = [{
      code: "temporary_source_warning",
      severity: "warning" as const,
      message: "temporarily unavailable",
      ordinal: null,
    }];
    const source: SessionSource = {
      ...staticSource("diagnostics", []),
      async refresh() {
        return {
          signature,
          sessions: [sourceEntry(
            "stable",
            normalizedSession("stable", "Stable", "/project", []),
          )],
          diagnostics,
        };
      },
    };
    const repository = new DefaultSessionRepository([source]);
    const first = await repository.list({});

    signature = "recovered";
    diagnostics = [];
    await repository.refresh();

    expect((await repository.list({})).listRevision).toBe(first.listRevision);
  });

  it("publishes linked summaries, pages one immutable revision, and replaces it after append", async () => {
    const { home, repository } = await fixtureRepository();
    const first = await repository.list({});
    expect(first.sessions).toHaveLength(3);
    expect(first.sessions.every((entry) => !entry.session.archived)).toBe(true);
    const archived = await repository.list({ archiveScope: "archived" });
    expect(archived.sessions).toHaveLength(1);
    expect(archived.sessions[0]?.session.archived).toBe(true);
    expect((await repository.list({ archiveScope: "all" })).sessions).toHaveLength(4);
    const parent = first.sessions.find((entry) => entry.session.title === "Synthetic trace")!;
    const child = first.sessions.find((entry) => entry.session.cwd === "/synthetic/child")!;
    expect(child.session.parentId).toBe(parent.session.id);
    expect(parent.session.childIds).toContain(child.session.id);

    const initialDetail = await repository.getSession(parent.session.id);
    const page = await repository.getItems(parent.session.id, {
      cursor: initialDetail!.context.cursor,
      limit: 2,
    });
    expect(page?.context.hasMore).toBe(true);
    await expect(repository.getItems(parent.session.id, {
      cursor: page!.context.cursor,
      limit: 2,
    })).resolves.not.toBeNull();
    const allItems = await repository.getItems(parent.session.id, {
      cursor: initialDetail!.context.cursor,
      limit: 200,
    });
    const directive = allItems!.items.find((item) => item.id === "directive-4")!;
    expect(JSON.stringify(allItems)).not.toContain("DIRECTIVE_DETAIL_CANARY");
    expect(await repository.getDirectiveDetail(parent.session.id, directive.id, {
      cursor: allItems!.context.cursor,
    })).toEqual(expect.objectContaining({
      sessionId: parent.session.id,
      itemId: directive.id,
      text: expect.stringContaining("DIRECTIVE_DETAIL_CANARY"),
      truncated: false,
    }));

    const rollout = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    const previous = await readFile(rollout, "utf8");
    await writeFile(
      rollout,
      `${previous}{"timestamp":"2026-07-28T10:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final","content":[{"type":"output_text","text":"Appended revision"}]}}\n`,
    );
    await repository.refresh();
    const second = await repository.getSession(parent.session.id, {
      cursor: page!.context.cursor,
    });
    expect(second!.context.cursor.sessionRevision)
      .not.toBe(initialDetail!.context.cursor.sessionRevision);
    expect(second!.context.session.messageCount)
      .toBe(parent.session.messageCount);
    expect(second!.context.cursor.throughOrdinal)
      .toBe(page!.context.cursor.throughOrdinal);
    expect(second!.context.hasMore).toBe(true);
    expect(first.sessions.find((entry) => entry.session.id === parent.session.id)?.session.messageCount)
      .toBe(parent.session.messageCount);
    await expect(repository.getItems(parent.session.id, {
      cursor: page!.context.cursor,
    })).resolves.not.toBeNull();
    await expect(repository.getDirectiveDetail(parent.session.id, directive.id, {
      cursor: allItems!.context.cursor,
    })).resolves.toEqual(expect.objectContaining({
      context: expect.objectContaining({
        cursor: expect.objectContaining({
          sessionRevision: second!.context.cursor.sessionRevision,
        }),
      }),
    }));

    const replacement = `${rollout}.replacement`;
    await writeFile(
      replacement,
      '{"timestamp":"2026-07-28T13:00:00.000Z","type":"session_meta","payload":{"id":"basic-session","title":"Replacement trace"}}\n' +
      '{"timestamp":"2026-07-28T13:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"replacement"}]}}\n',
    );
    await rename(replacement, rollout);
    await repository.refresh();
    const third = await repository.getSession(parent.session.id);
    expect(third!.context.cursor.sessionRevision)
      .not.toBe(second!.context.cursor.sessionRevision);
    expect(third!.context.session.title).toBe("Replacement trace");
    expect(third!.context.session.messageCount).toBe(0);
    await expect(repository.getSession(parent.session.id, {
      cursor: page!.context.cursor,
    })).rejects.toMatchObject<Partial<RepositoryQueryError>>({
      code: "stale_timeline_prefix",
    });
  });

  it("keeps a loaded call prefix stable when an output is appended", async () => {
    const home = await createTempDirectory("codex-tool-append-");
    const directory = join(home, "sessions");
    await mkdir(directory, { recursive: true });
    const rollout = join(directory, "rollout-tool-append.jsonl");
    await writeFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:00Z","type":"session_meta","payload":{"id":"tool-append","title":"Tool append"}}\n' +
      '{"timestamp":"2026-07-28T10:00:01Z","type":"response_item","payload":{"type":"function_call","name":"inspect","arguments":"input","call_id":"stable-call"}}\n',
    );
    const repository = await createCodexSessionRepository(home);
    const listed = await repository.list({});
    const sessionId = listed.sessions[0]!.session.id;
    const initial = await repository.getSession(sessionId);
    const callPage = await repository.getItems(sessionId, {
      cursor: initial!.context.cursor,
      limit: 1,
    });
    const call = callPage!.items[0]!;
    expect(call).toMatchObject({
      kind: "tool",
      stage: "call",
      callId: "stable-call",
    });
    const callDetailBefore = await repository.getToolDetail(sessionId, call.id, {
      cursor: callPage!.context.cursor,
    });

    await appendFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:02Z","type":"response_item","payload":{"type":"function_call_output","call_id":"stable-call","output":"result"}}\n',
    );
    await repository.refresh();

    const continuation = await repository.getItems(sessionId, {
      cursor: callPage!.context.cursor,
      limit: 1,
    });
    expect(continuation!.items).toEqual([
      expect.objectContaining({
        kind: "tool",
        stage: "output",
        callId: "stable-call",
        status: "completed",
        preview: "result",
      }),
    ]);
    expect(continuation!.context.session).toMatchObject({
      toolCount: 1,
      itemCount: 2,
    });
    const callDetailAfter = await repository.getToolDetail(sessionId, call.id, {
      cursor: callPage!.context.cursor,
    });
    expect({
      input: callDetailAfter!.input,
      output: callDetailAfter!.output,
      truncated: callDetailAfter!.truncated,
    }).toEqual({
      input: callDetailBefore!.input,
      output: callDetailBefore!.output,
      truncated: callDetailBefore!.truncated,
    });
    expect(callDetailAfter).toMatchObject({
      input: "input",
      output: null,
      truncated: false,
    });
  });

  it("does not revise a session until an appended JSONL tail is terminated", async () => {
    const home = await createTempDirectory("codex-silent-tail-");
    const directory = join(home, "sessions");
    await mkdir(directory, { recursive: true });
    const rollout = join(directory, "rollout-silent-tail.jsonl");
    await writeFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:00Z","type":"session_meta","payload":{"id":"silent-tail","title":"Silent tail"}}\n',
    );
    const repository = await createCodexSessionRepository(home);
    const sessionId = (await repository.list({})).sessions[0]!.session.id;
    const before = await repository.getSession(sessionId);

    await appendFile(
      rollout,
      '{"timestamp":"2026-07-28T10:00:01Z","type":"response_item","payload":{"type":"function_call","name":"pending","arguments":"input","call_id":"tail-call"}}',
    );
    await repository.refresh();
    const pending = await repository.getSession(sessionId);
    expect(pending!.context.cursor.sessionRevision)
      .toBe(before!.context.cursor.sessionRevision);
    expect(pending!.context.session).toEqual(before!.context.session);

    await appendFile(rollout, "\n");
    await repository.refresh();
    const committed = await repository.getSession(sessionId);
    expect(committed!.context.cursor.sessionRevision)
      .not.toBe(before!.context.cursor.sessionRevision);
    expect(committed!.context.session).toMatchObject({ toolCount: 1, itemCount: 1 });
  });

  it("keeps session A reader requests valid while only session B changes", async () => {
    const sessionA = normalizedSession("session-a", "Session A", null, [
      {
        kind: "message",
        id: "message-1",
        ordinal: 1,
        timestamp: null,
        role: "user",
        phase: null,
        markdown: "first",
      },
      {
        kind: "directive",
        id: "directive-2",
        ordinal: 2,
        timestamp: null,
        summary: "detail",
        charCount: 6,
        truncated: false,
        hasDetail: true,
      },
      {
        kind: "message",
        id: "message-3",
        ordinal: 3,
        timestamp: null,
        role: "assistant",
        phase: "final",
        markdown: "later",
      },
    ]);
    let sessionAWithDetail: NormalizedSession = {
      ...sessionA,
      directiveDetails: new Map([[
        "directive-2",
        { text: "secret", truncated: false },
      ]]),
    };
    let sourceSignature = "initial";
    let sessionB = normalizedSession("session-b", "Session B", null, []);
    const source: SessionSource = {
      ...staticSource("mutable", []),
      async refresh() {
        return {
          signature: sourceSignature,
          sessions: [
            sourceEntry("session-a", sessionAWithDetail),
            sourceEntry("session-b", sessionB),
          ],
          diagnostics: [],
        };
      },
    };
    const repository = new DefaultSessionRepository([source]);
    const list = await repository.list({});
    const sessionAId = list.sessions.find((entry) => entry.session.title === "Session A")!.session.id;
    const detail = await repository.getSession(sessionAId);
    const first = await repository.getItems(sessionAId, {
      cursor: detail!.context.cursor,
      limit: 2,
    });
    const directive = first!.items.find((item) => item.kind === "directive")!;

    let latestListRevision = list.listRevision;
    for (const change of ["changed-once", "changed-twice"]) {
      sourceSignature = `session-b-${change}`;
      sessionB = normalizedSession("session-b", `Session B ${change}`, null, []);
      await repository.refresh();
      const nextListRevision = (await repository.list({})).listRevision;
      expect(nextListRevision).toBe(latestListRevision);
      latestListRevision = nextListRevision;
      expect((await repository.getSession(sessionAId))?.context.cursor.sessionRevision)
        .toBe(detail!.context.cursor.sessionRevision);
    }

    await expect(repository.getItems(sessionAId, {
      cursor: first!.context.cursor,
      limit: 2,
    })).resolves.toEqual(expect.objectContaining({
      items: [expect.objectContaining({ id: "message-3" })],
    }));
    await expect(repository.getDirectiveDetail(sessionAId, directive.id, {
      cursor: first!.context.cursor,
    })).resolves.toEqual(expect.objectContaining({ text: "secret" }));

    const currentList = await repository.list({});
    const sessionBId = currentList.sessions.find(
      (entry) => entry.session.title === "Session B changed-twice",
    )!.session.id;
    const sessionBDetail = await repository.getSession(sessionBId);
    sessionAWithDetail = {
      ...sessionAWithDetail,
      session: { ...sessionAWithDetail.session, title: "Session A changed" },
    };
    sourceSignature = "session-a-changed";
    await repository.refresh();

    await expect(repository.getItems(sessionAId, {
      cursor: first!.context.cursor,
      limit: 2,
    })).resolves.toEqual(expect.objectContaining({
      context: expect.objectContaining({
        session: expect.objectContaining({ title: "Session A changed" }),
      }),
    }));
    await expect(repository.getItems(sessionBId, {
      cursor: sessionBDetail!.context.cursor,
      limit: 2,
    })).resolves.toEqual(expect.objectContaining({ items: [] }));
  });

  it("keeps a parent revision stable when source child enumeration order changes", async () => {
    let sourceSignature = "children-z-a";
    let childIds = ["child-z", "child-a"];
    const source: SessionSource = {
      ...staticSource("reordered-children", []),
      async refresh() {
        return {
          signature: sourceSignature,
          sessions: [
            sourceEntry(
              "parent",
              normalizedSession("parent", "Parent", null, []),
            ),
            ...childIds.map((childId) =>
              sourceEntry(
                childId,
                normalizedSession(childId, childId, null, []),
                "parent",
              )
            ),
          ],
          diagnostics: [],
        };
      },
    };
    const repository = new DefaultSessionRepository([source]);
    const firstList = await repository.list({});
    const parentId = firstList.sessions.find(
      ({ session }) => session.title === "Parent",
    )!.session.id;
    const first = await repository.getSession(parentId);

    expect(first?.context.session.childIds).toEqual(
      [...first!.context.session.childIds].sort(),
    );

    sourceSignature = "children-a-z";
    childIds = [...childIds].reverse();
    await repository.refresh();
    const second = await repository.getSession(parentId);

    expect((await repository.list({})).listRevision).toBe(firstList.listRevision);
    expect(second?.context.session.childIds)
      .toEqual(first?.context.session.childIds);
    expect(second?.context.cursor.sessionRevision)
      .toBe(first?.context.cursor.sessionRevision);
  });

  it("returns every timeline event type in one unfiltered view", async () => {
    const { repository } = await fixtureRepository();
    const list = await repository.list({});
    const session = list.sessions.find((entry) => entry.session.title === "Synthetic trace")!;
    const detail = await repository.getSession(session.session.id);
    const page = await repository.getItems(session.session.id, {
      cursor: detail!.context.cursor,
      limit: 200,
    });
    expect(new Set(page?.items.map((item) => item.kind))).toEqual(new Set([
      "message",
      "directive",
      "tool",
      "token",
      "internal",
    ]));
    expect(page?.items.find((item) =>
      item.kind === "internal" && item.eventType === "reasoning"
    )).toEqual(
      expect.objectContaining({
        id: "internal-6",
        summary: "REASONING_SUMMARY_CANARY",
      }),
    );
  });

  it("accepts item pages up to 300 entries", async () => {
    const { repository } = await fixtureRepository();
    const list = await repository.list({});
    const session = list.sessions.find((entry) => entry.session.title === "Synthetic trace")!;
    const detail = await repository.getSession(session.session.id);
    await expect(repository.getItems(session.session.id, {
      cursor: detail!.context.cursor,
      limit: 300,
    }))
      .resolves.not.toBeNull();
    await expect(repository.getItems(session.session.id, {
      cursor: detail!.context.cursor,
      limit: 301,
    }))
      .rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });
  });

  it("defaults timeline pages to 100 entries", async () => {
    const timeline: DomainTimelineRecord[] = Array.from(
      { length: 101 },
      (_, index) => ({
        kind: "message",
        id: `message-${index + 1}`,
        ordinal: index + 1,
        timestamp: "2026-07-28T00:00:00Z",
        role: "assistant",
        phase: "commentary",
        markdown: `Message ${index + 1}`,
      }),
    );
    const repository = new DefaultSessionRepository(
      [staticSource("timeline-default", [
        sourceEntry(
          "timeline-default",
          normalizedSession("timeline-default", "Timeline default", null, timeline),
        ),
      ])],
    );
    const session = (await repository.list({})).sessions[0]!.session;
    const detail = await repository.getSession(session.id);
    const page = await repository.getItems(session.id, {
      cursor: detail!.context.cursor,
    });

    expect(page?.items).toHaveLength(100);
    expect(page?.context.hasMore).toBe(true);
  });

  it("searches only permitted fields and reports bounded partial results", async () => {
    const { repository } = await fixtureRepository();
    expect((await repository.list({ q: "Synthetic trace" })).sessions).toHaveLength(1);
    expect((await repository.list({ q: "/synthetic/project" })).sessions).toHaveLength(1);
    expect((await repository.list({ q: "The synthetic widget is ready" })).sessions).toHaveLength(1);
    for (const canary of [
      "DEVELOPER_DIRECTIVE_CANARY",
      "REASONING_CANARY_NEVER_RENDER",
      "REASONING_SUMMARY_CANARY",
      "INTERNAL_PAYLOAD_CANARY",
      "DIRECTIVE_DETAIL_CANARY",
      "synthetic result",
      "call-complete",
    ]) {
      expect((await repository.list({ q: canary })).sessions).toHaveLength(0);
    }

    const partial = searchDocuments(
      [{ sessionId: "one", title: "anything", cwd: "", messages: [] }],
      "anything",
      { maxScannedBytes: 0, maxResults: 1, maxExcerptChars: 20, maxDurationMs: 100 },
    );
    expect(partial.partial).toBe(true);
    expect(partial.warnings[0]?.code).toBe("search_byte_budget");

    const resultBudget = await repository.list({ q: "synthetic", limit: 1 });
    expect(resultBudget.sessions).toHaveLength(1);
  });

  it("applies archive scope before bounded full-text search", async () => {
    const home = await createTempDirectory("codex-archive-search-");
    await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
    const archivedRollout = join(
      home,
      "archived_sessions/rollout-2026-07-20T08-00-00-archived-session.jsonl",
    );
    const archivedSource = await readFile(archivedRollout, "utf8");
    await writeFile(
      archivedRollout,
      `${archivedSource}{"timestamp":"2026-07-20T08:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"${"x".repeat(2_000)}"}]}}\n`,
    );
    const repository = await createCodexSessionRepository(home, {
      maxScannedBytes: 1_000,
      maxResults: 200,
      maxExcerptChars: 240,
      maxDurationMs: 1_000,
    });

    const result = await repository.list({
      archiveScope: "active",
      q: "Synthetic trace",
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.partial).toBe(false);
  });

  it("discovers an archived root created after repository startup", async () => {
    const home = await createTempDirectory("codex-late-archive-");
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "sessions/rollout-active.jsonl"),
      '{"timestamp":"2026-07-28T10:00:00.000Z","type":"session_meta","payload":{"id":"active-session","title":"Active trace"}}\n',
    );
    const repository = await createCodexSessionRepository(home);
    expect((await repository.list({ archiveScope: "all" })).sessions).toHaveLength(1);

    await mkdir(join(home, "archived_sessions"), { recursive: true });
    await writeFile(
      join(home, "archived_sessions/rollout-archived.jsonl"),
      '{"timestamp":"2026-07-20T10:00:00.000Z","type":"session_meta","payload":{"id":"archived-session","title":"Late archive"}}\n',
    );
    await repository.refresh();

    const archived = await repository.list({ archiveScope: "archived" });
    expect(archived.sessions).toHaveLength(1);
    expect(archived.sessions[0]?.session.title).toBe("Late archive");
  });

  it("keeps a native Codex session identity stable when its rollout moves", async () => {
    const { home, repository } = await fixtureRepository();
    const before = await repository.list({ archiveScope: "all" });
    const session = before.sessions.find(
      (entry) => entry.session.title === "Synthetic trace",
    )!.session;
    const original = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    const archiveDirectory = join(home, "archived_sessions/reorganized");
    await mkdir(archiveDirectory, { recursive: true });
    await rename(original, join(archiveDirectory, "rollout-moved-basic-session.jsonl"));

    await repository.refresh();
    const after = await repository.list({ archiveScope: "all" });
    const moved = after.sessions.find(
      (entry) => entry.session.title === "Synthetic trace",
    )!.session;
    expect(moved.id).toBe(session.id);
    expect(moved.archived).toBe(true);
  });

  it("compares time filters as instants and rejects an inverted range", async () => {
    const { repository } = await fixtureRepository();
    const equivalentOffset = await repository.list({
      from: "2026-07-28T05:00:00-05:00",
      to: "2026-07-28T13:00:00Z",
    });
    expect(equivalentOffset.sessions.some(
      (entry) => entry.session.title === "Synthetic trace",
    )).toBe(true);

    await expect(repository.list({
      from: "2026-07-29T00:00:00Z",
      to: "2026-07-28T00:00:00Z",
    })).rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });
  });

  it("defaults catalog pages to 100 entries and accepts up to 300", async () => {
    const entries = Array.from({ length: 305 }, (_, index) =>
      sourceEntry(
        `thread-${index}`,
        normalizedSession(
          `thread-${index}`,
          `Session ${String(index).padStart(3, "0")}`,
          "/synthetic/large-catalog",
          [],
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        ),
      )
    );
    const repository = new DefaultSessionRepository(
      [staticSource("large", entries)],
    );

    const first = await repository.list({});
    expect(first).toMatchObject({ total: 305, hasMore: true, nextOffset: 100 });
    expect(first.sessions).toHaveLength(100);
    await expect(repository.list({ offset: 100, limit: 300 }))
      .rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });
    const second = await repository.list({
      offset: first.nextOffset!,
      limit: 300,
      listRevision: first.listRevision,
    });
    expect(second).toMatchObject({ total: 305, hasMore: false, nextOffset: null });
    expect(second.sessions).toHaveLength(205);
    expect(new Set([...first.sessions, ...second.sessions].map((entry) => entry.session.id)).size)
      .toBe(305);
    await expect(repository.list({ limit: 301 }))
      .rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });
  });

  it("bounds a page of individually valid long messages by response bytes", async () => {
    const longText = "x".repeat(1_000_000);
    const timeline: DomainTimelineRecord[] = Array.from(
      { length: 10 },
      (_, index) => ({
        kind: "message",
        id: `message-${index + 1}`,
        ordinal: index + 1,
        timestamp: "2026-07-28T00:00:00Z",
        role: "assistant",
        phase: "commentary",
        markdown: longText,
      }),
    );
    const repository = new DefaultSessionRepository(
      [staticSource("long", [
        sourceEntry(
          "long-session",
          normalizedSession("long-session", "Long session", null, timeline),
        ),
      ])],
    );

    const list = await repository.list({});
    const detail = await repository.getSession(list.sessions[0]!.session.id);
    const page = await repository.getItems(list.sessions[0]!.session.id, {
      cursor: detail!.context.cursor,
      limit: 200,
    });
    expect(page?.context.hasMore).toBe(true);
    expect(page?.context.cursor.throughOrdinal)
      .toBe(page?.items.at(-1)?.ordinal);
    expect(Buffer.byteLength(JSON.stringify(page?.items), "utf8"))
      .toBeLessThanOrEqual(MAX_ITEM_PAGE_BYTES + 2);
  });
});

const TEST_ORIGIN = {
  sourceType: "test",
  sourceInstanceId: "test-source",
  agentName: "Test",
  agentVersion: null,
  formatVersion: null,
} as const;

function normalizedSession(
  id: string,
  title: string,
  cwd: string | null,
  timeline: readonly DomainTimelineRecord[],
  timestamp = "2026-01-01T00:00:00Z",
): NormalizedSession {
  return {
    session: {
      id,
      sourceId: id,
      origin: TEST_ORIGIN,
      title,
      preview: null,
      cwd,
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      messageCount: timeline.filter((item) => item.kind === "message").length,
      toolCount: timeline.filter(
        (item) => item.kind === "tool" && item.stage === "call",
      ).length,
      warningCount: 0,
      diagnostics: [],
      itemCount: timeline.length,
    },
    timeline,
    toolDetails: new Map(),
    directiveDetails: new Map(),
  };
}

function sourceEntry(
  localId: string,
  normalized: NormalizedSession,
  parentNativeSessionId: string | null = null,
): SourceSessionEntry {
  return {
    localId,
    nativeSessionId: localId,
    parentNativeSessionId,
    origin: TEST_ORIGIN,
    normalized,
  };
}

function staticSource(
  key: string,
  sessions: readonly SourceSessionEntry[],
): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey: key,
      sourceInstanceId: key,
      displayName: "Test",
    },
    async refresh() {
      return { signature: key, sessions, diagnostics: [] };
    },
  };
}
