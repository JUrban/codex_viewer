import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexCatalogSource } from "../../src/server/codex/catalog-source.js";
import { IdentityResolver } from "../../src/server/codex/identity-resolver.js";
import { WholeFileRolloutDecoder } from "../../src/server/codex/rollout-decoder.js";
import { DefaultSessionNormalizer } from "../../src/server/codex/session-normalizer.js";
import { createSessionRepository } from "../../src/server/repository/create-session-repository.js";
import {
  DEFAULT_CATALOG_FRESHNESS_MS,
  DefaultSessionRepository,
  MAX_ITEM_PAGE_BYTES,
  RepositoryQueryError,
} from "../../src/server/repository/session-repository.js";
import { searchDocuments } from "../../src/server/search/search-document.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

async function fixtureRepository() {
  const home = await createTempDirectory("codex-repository-");
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  return { home, repository: await createSessionRepository(home, true) };
}

describe("DefaultSessionRepository", () => {
  it("coalesces concurrent refreshes, reuses a fresh snapshot, and permits a forced refresh", async () => {
    let discoveries = 0;
    let now = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const source: CodexCatalogSource = {
      async discover() {
        discoveries += 1;
        await gate;
        return { mode: "unavailable", entries: [], diagnostics: [] };
      },
    };
    const repository = new DefaultSessionRepository(
      source,
      new WholeFileRolloutDecoder(),
      new IdentityResolver(),
      new DefaultSessionNormalizer(),
      undefined,
      DEFAULT_CATALOG_FRESHNESS_MS,
      () => now,
    );

    const status = repository.getStatus();
    const list = repository.list({});
    release();
    expect((await status).generation).toBe(1);
    expect((await list).generation).toBe(1);
    expect(discoveries).toBe(1);
    expect((await repository.getStatus()).generation).toBe(1);
    expect(discoveries).toBe(1);
    now = DEFAULT_CATALOG_FRESHNESS_MS - 1;
    expect((await repository.getStatus()).generation).toBe(1);
    expect(discoveries).toBe(1);
    now = DEFAULT_CATALOG_FRESHNESS_MS;
    expect((await repository.getStatus()).generation).toBe(1);
    expect(discoveries).toBe(2);
    expect(await repository.refresh()).toBe(1);
    expect(discoveries).toBe(3);
  });

  it("publishes linked summaries, pages one immutable generation, and replaces it after append", async () => {
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

    const page = await repository.getItems(parent.session.id, { limit: 2 });
    expect(page?.hasMore).toBe(true);
    expect(page?.nextAfterOrdinal).not.toBeNull();
    await expect(repository.getItems(parent.session.id, {
      afterOrdinal: page!.nextAfterOrdinal!,
      limit: 2,
    })).rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });
    const allItems = await repository.getItems(parent.session.id, {
      limit: 200,
    });
    const directive = allItems!.items.find((item) => item.kind === "directive")!;
    expect(JSON.stringify(allItems)).not.toContain("DIRECTIVE_DETAIL_CANARY");
    expect(await repository.getDirectiveDetail(parent.session.id, directive.id, {
      generation: allItems!.generation,
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
      `${previous}{"timestamp":"2026-07-28T10:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final","content":[{"type":"output_text","text":"Appended generation"}]}}\n`,
    );
    await repository.refresh();
    const second = await repository.getSession(parent.session.id);
    expect(second!.generation).toBeGreaterThan(first.generation);
    expect(second!.session.messageCount).toBe(parent.session.messageCount + 1);
    expect(first.sessions.find((entry) => entry.session.id === parent.session.id)?.session.messageCount)
      .toBe(parent.session.messageCount);
    await expect(repository.getItems(parent.session.id, {
      afterOrdinal: page!.nextAfterOrdinal!,
      generation: first.generation,
    })).rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "stale_generation" });
    await expect(repository.getDirectiveDetail(parent.session.id, directive.id, {
      generation: allItems!.generation,
    })).rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "stale_generation" });

    const replacement = `${rollout}.replacement`;
    await writeFile(
      replacement,
      '{"timestamp":"2026-07-28T13:00:00.000Z","type":"session_meta","payload":{"id":"basic-session","title":"Replacement trace"}}\n' +
      '{"timestamp":"2026-07-28T13:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"replacement"}]}}\n',
    );
    await rename(replacement, rollout);
    await repository.refresh();
    const third = await repository.getSession(parent.session.id);
    expect(third!.generation).toBeGreaterThan(second!.generation);
    expect(third!.session.title).toBe("Replacement trace");
    expect(third!.session.messageCount).toBe(0);
  });

  it("returns every timeline event type in one unfiltered view", async () => {
    const { repository } = await fixtureRepository();
    const list = await repository.list({});
    const session = list.sessions.find((entry) => entry.session.title === "Synthetic trace")!;
    const page = await repository.getItems(session.session.id, {
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

  it("accepts item pages up to 512 entries", async () => {
    const { repository } = await fixtureRepository();
    const list = await repository.list({});
    const session = list.sessions.find((entry) => entry.session.title === "Synthetic trace")!;
    await expect(repository.getItems(session.session.id, { limit: 512 }))
      .resolves.not.toBeNull();
    await expect(repository.getItems(session.session.id, { limit: 513 }))
      .rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });
  });

  it("searches only permitted fields and reports bounded partial results", async () => {
    const { repository } = await fixtureRepository();
    expect((await repository.list({ q: "Synthetic trace" })).sessions).toHaveLength(1);
    expect((await repository.list({ q: "/synthetic/project" })).sessions).toHaveLength(1);
    expect((await repository.list({ q: "Final synthetic answer" })).sessions).toHaveLength(1);
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
    const repository = await createSessionRepository(home, true, {
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
    const repository = await createSessionRepository(home, true);
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

  it("pages catalogs larger than the per-response safety limit", async () => {
    const entries = Array.from({ length: 205 }, (_, index) => ({
      descriptor: {
        id: `session-${index}`,
        canonicalPath: `/synthetic/rollout-${index}.jsonl`,
        archived: false,
        size: 1,
        mtimeMs: index,
        device: 1,
        inode: index,
      },
      metadata: {
        threadId: `thread-${index}`,
        title: `Session ${String(index).padStart(3, "0")}`,
        cwd: "/synthetic/large-catalog",
        createdAt: null,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        parentThreadId: null,
        archived: false,
      },
    }));
    const repository = new DefaultSessionRepository(
      { discover: async () => ({ mode: "jsonl" as const, entries, diagnostics: [] }) },
      {
        decode: async (descriptor) => ({
          descriptor,
          records: [],
          diagnostics: [],
          incompleteTail: false,
        }),
      },
      new IdentityResolver(),
      new DefaultSessionNormalizer(),
    );

    const first = await repository.list({ limit: 200 });
    expect(first).toMatchObject({ total: 205, hasMore: true, nextOffset: 200 });
    await expect(repository.list({ offset: 200, limit: 200 }))
      .rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });
    const second = await repository.list({
      offset: first.nextOffset!,
      limit: 200,
      generation: first.generation,
    });
    expect(second).toMatchObject({ total: 205, hasMore: false, nextOffset: null });
    expect(second.sessions).toHaveLength(5);
    expect(new Set([...first.sessions, ...second.sessions].map((entry) => entry.session.id)).size)
      .toBe(205);
  });

  it("bounds a page of individually valid long messages by response bytes", async () => {
    const descriptor = {
      id: "long-session",
      canonicalPath: "/synthetic/rollout-long-session.jsonl",
      archived: false,
      size: 1,
      mtimeMs: 1,
      device: 1,
      inode: 1,
    };
    const longText = "x".repeat(1_000_000);
    const repository = new DefaultSessionRepository(
      {
        discover: async () => ({
          mode: "jsonl" as const,
          entries: [{ descriptor, metadata: null }],
          diagnostics: [],
        }),
      },
      {
        decode: async () => ({
          descriptor,
          records: Array.from({ length: 10 }, (_, index) => ({
            ordinal: index + 1,
            value: {
              timestamp: "2026-07-28T00:00:00Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                phase: "commentary",
                content: [{ type: "output_text", text: longText }],
              },
            },
          })),
          diagnostics: [],
          incompleteTail: false,
        }),
      },
      new IdentityResolver(),
      new DefaultSessionNormalizer(),
    );

    const list = await repository.list({});
    const page = await repository.getItems(list.sessions[0]!.session.id, { limit: 200 });
    expect(page?.hasMore).toBe(true);
    expect(page?.nextAfterOrdinal).toBe(page?.items.at(-1)?.ordinal);
    expect(Buffer.byteLength(JSON.stringify(page?.items), "utf8"))
      .toBeLessThanOrEqual(MAX_ITEM_PAGE_BYTES + 2);
  });
});
