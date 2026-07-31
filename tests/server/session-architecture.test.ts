import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionApiMapper } from "../../src/server/api/session-api-mapper.js";
import type {
  DomainSession,
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import {
  CatalogSnapshotStore,
  type CatalogSnapshot,
} from "../../src/server/repository/catalog-snapshot-store.js";
import {
  RepositoryQueryError,
  SessionQueryService,
} from "../../src/server/repository/session-query-service.js";
import { deriveSessionView } from "../../src/server/repository/session-view-digest.js";
import type {
  SessionSource,
  SourceSessionEntry,
} from "../../src/server/source/session-source.js";

const session: DomainSession = {
  id: "session-one",
  sourceId: "private-source-id",
  origin: {
    sourceType: "test",
    sourceInstanceId: "test-source",
    agentName: "Test Agent",
    agentVersion: "1.0.0",
    formatVersion: null,
  },
  title: "Session one",
  preview: "Preview",
  cwd: "/project",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T01:00:00Z",
  archived: false,
  parentId: null,
  childIds: ["child"],
  agent: { taskName: "task", nickname: null, role: "worker" },
  messageCount: 1,
  toolCount: 0,
  warningCount: 1,
  diagnostics: [{
    code: "partial",
    severity: "warning",
    message: "Partial",
    ordinal: 2,
  }],
  itemCount: 1,
};

const timeline: readonly DomainTimelineRecord[] = [{
  kind: "token",
  id: "token-1",
  ordinal: 1,
  timestamp: null,
  tokenUsage: {
    total: {
      totalTokens: 10,
      inputTokens: 8,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 2,
      reasoningOutputTokens: null,
    },
    last: null,
  },
}];

const normalized: NormalizedSession = {
  session,
  timeline,
  toolDetails: new Map(),
  directiveDetails: new Map(),
};

describe("server architecture boundaries", () => {
  it("keeps generic server modules independent from the Codex adapter", async () => {
    const genericDirectories = [
      "api",
      "domain",
      "http",
      "repository",
      "search",
      "security",
      "source",
    ];
    const files = (
      await Promise.all(
        genericDirectories.map((directory) =>
          typescriptFiles(resolve("src/server", directory))
        ),
      )
    ).flat();

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(
        /(?:from\s+|import\s*\()["'][^"']*adapters\/codex/,
      );
    }
  });

  it("maps domain values exactly without leaking private summary fields or mutable references", () => {
    const mapper = new SessionApiMapper();
    const queries = new SessionQueryService();
    const read = queries.session(snapshotOf(normalized), "session-one")!;
    const detail = mapper.detail(read);
    const summary = mapper.summary(session);
    const item = mapper.timelineItem(timeline[0]!);

    expect(summary).toEqual({
      id: "session-one",
      origin: {
        sourceType: "test",
        sourceInstanceId: "test-source",
        agentName: "Test Agent",
        agentVersion: "1.0.0",
        formatVersion: null,
      },
      title: "Session one",
      preview: "Preview",
      cwd: "/project",
      createdAt: "2026-07-28T00:00:00Z",
      updatedAt: "2026-07-28T01:00:00Z",
      archived: false,
      parentId: null,
      childIds: ["child"],
      agent: { taskName: "task", nickname: null, role: "worker" },
      messageCount: 1,
      toolCount: 0,
      warningCount: 1,
    });
    expect(summary).not.toHaveProperty("sourceId");
    expect(detail).toEqual({
      context: {
        cursor: {
          sessionRevision: "r".repeat(32),
          throughOrdinal: 0,
          timelinePrefixRevision: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
        },
        hasMore: true,
        session: {
          ...summary,
          sourceId: "private-source-id",
          diagnostics: [{
            code: "partial",
            severity: "warning",
            message: "Partial",
            ordinal: 2,
          }],
          itemCount: 1,
        },
      },
    });

    summary.childIds.push("mutated");
    detail.context.session.diagnostics[0]!.message = "mutated";
    if (item.kind === "token" && item.tokenUsage.total) {
      item.tokenUsage.total.totalTokens = 99;
    }
    expect(session.childIds).toEqual(["child"]);
    expect(session.diagnostics[0]!.message).toBe("Partial");
    expect(
      timeline[0]?.kind === "token"
        ? timeline[0].tokenUsage.total?.totalTokens
        : null,
    ).toBe(10);
  });

  it("filters lists, publishes facets, and reads timeline items", () => {
    const queries = new SessionQueryService();
    const snapshot = snapshotOf(normalized);
    const first = queries.list(snapshot, { project: "/project", limit: 1 });
    expect(first).toMatchObject({
      listRevision: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      total: 1,
      hasMore: false,
      projects: [{ project: "/project", count: 1 }],
    });
    const read = queries.session(snapshot, "session-one")!;
    expect(queries.items(snapshot, "session-one", {
      cursor: {
        sessionRevision: read.sessionRevision,
        throughOrdinal: read.throughOrdinal,
        timelinePrefixRevision: read.timelinePrefixRevision,
      },
    })?.items).toEqual(timeline);
  });

  it("rejects cursors whose through ordinal is not an actual timeline boundary", () => {
    const gapped: NormalizedSession = {
      ...normalized,
      timeline: [{ ...timeline[0]!, ordinal: 5 }],
    };
    const snapshot = snapshotOf(gapped);
    const versioned = snapshot.sessions.get(session.id)!;
    const boundary = versioned.timelinePrefixIndex.boundaryAt(
      gapped.timeline,
      5,
    )!;

    expect(() => new SessionQueryService().session(snapshot, session.id, {
      cursor: {
        sessionRevision: versioned.revision,
        throughOrdinal: 8,
        timelinePrefixRevision: boundary.timelinePrefixRevision,
      },
    })).toThrowError(expect.objectContaining<Partial<RepositoryQueryError>>({
      code: "stale_timeline_prefix",
    }));
  });

  it("rejects duplicate source instances and propagates source invariant failures", async () => {
    const source = {
      descriptor: {
        sourceType: "test",
        instanceKey: "test-source",
        sourceInstanceId: "test-source",
        displayName: "Test",
      },
      refresh: vi.fn(async () => {
        throw new Error("source invariant");
      }),
    };
    expect(() => new CatalogSnapshotStore([source, source])).toThrow(
      "Duplicate session source instance key",
    );
    await expect(new CatalogSnapshotStore([source]).current()).rejects.toThrow(
      "source invariant",
    );
  });

  it("namespaces source identities, links parents locally, and ignores source order", async () => {
    const sourceA = testSource("source-a", [
      sourceEntry("parent", null, "Source A parent"),
      sourceEntry("child-z", "parent", "Source A child Z"),
      sourceEntry("child-a", "parent", "Source A child A"),
    ]);
    const sourceAWithReorderedEntries = testSource("source-a", [
      sourceEntry("parent", null, "Source A parent"),
      sourceEntry("child-a", "parent", "Source A child A"),
      sourceEntry("child-z", "parent", "Source A child Z"),
    ]);
    const sourceB = testSource("source-b", [
      sourceEntry("parent", null, "Source B parent"),
      sourceEntry("child", "missing-in-source-b", "Source B child"),
    ]);
    const first = await new CatalogSnapshotStore([sourceA, sourceB]).current();
    const reordered = await new CatalogSnapshotStore([sourceB, sourceA]).current();
    const reorderedEntries = await new CatalogSnapshotStore([
      sourceAWithReorderedEntries,
      sourceB,
    ]).current();

    expect(first.signature).toBe(reordered.signature);
    expect(first.signature).toBe(reorderedEntries.signature);
    expect(first.orderedIds).toEqual(reordered.orderedIds);
    const queries = new SessionQueryService();
    expect(queries.list(first, { archiveScope: "all" }).listRevision).toBe(
      queries.list(reordered, { archiveScope: "all" }).listRevision,
    );
    expect([...first.sessions.keys()].sort()).toEqual(
      [...reordered.sessions.keys()].sort(),
    );
    const byTitle = new Map(
      [...first.sessions.values()].map(({ normalized: value }) => [
        value.session.title,
        value.session,
      ]),
    );
    expect(byTitle.get("Source A parent")?.id)
      .not.toBe(byTitle.get("Source B parent")?.id);
    expect(byTitle.get("Source A child A")?.parentId)
      .toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source A child Z")?.parentId)
      .toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source B child")?.parentId).toBeNull();
    const parent = byTitle.get("Source A parent")!;
    expect(parent.childIds).toEqual([...parent.childIds].sort());
    expect(parent.childIds).toEqual(
      [...reorderedEntries.sessions.values()]
        .find(({ normalized: value }) => value.session.title === "Source A parent")!
        .normalized.session.childIds,
    );
  });

  it("uses session ID as the final tie-breaker across source registration order", async () => {
    const sourceA = testSource("tie-a", [sourceEntry("same", null, "Tie")]);
    const sourceB = testSource("tie-b", [sourceEntry("same", null, "Tie")]);
    const first = await new CatalogSnapshotStore([sourceA, sourceB]).current();
    const reversed = await new CatalogSnapshotStore([sourceB, sourceA]).current();

    expect(first.orderedIds).toEqual(reversed.orderedIds);
    const queries = new SessionQueryService({
      maxScannedBytes: 1_000_000,
      maxResults: 1,
      maxExcerptChars: 100,
      maxDurationMs: 1_000,
    });
    const firstResult = queries.list(first, { q: "tie" });
    const reversedResult = queries.list(reversed, { q: "tie" });
    expect(firstResult.sessions.map(({ session: value }) => value.id)).toEqual(
      reversedResult.sessions.map(({ session: value }) => value.id),
    );
    expect(firstResult.listRevision).toBe(reversedResult.listRevision);
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

function snapshotOf(value: NormalizedSession): CatalogSnapshot {
  const { timelinePrefixIndex } = deriveSessionView(
    value,
    Buffer.alloc(32, 7),
  );
  return {
    signature: "snapshot",
    diagnostics: [],
    sessions: new Map([[
      value.session.id,
      {
        revision: "r".repeat(32),
        normalized: value,
        timelinePrefixIndex,
      },
    ]]),
    documents: [{
      sessionId: value.session.id,
      title: value.session.title,
      agentTerms: [],
      cwd: value.session.cwd ?? "",
      messages: [],
    }],
    orderedIds: [value.session.id],
  };
}

function sourceEntry(
  nativeSessionId: string,
  parentNativeSessionId: string | null,
  title: string,
): SourceSessionEntry {
  const origin = {
    sourceType: "test",
    sourceInstanceId: "replaced-by-source",
    agentName: "Test",
    agentVersion: null,
    formatVersion: null,
  };
  return {
    localId: nativeSessionId,
    nativeSessionId,
    parentNativeSessionId,
    origin,
    normalized: {
      ...normalized,
      session: {
        ...normalized.session,
        id: nativeSessionId,
        sourceId: nativeSessionId,
        origin,
        title,
        parentId: parentNativeSessionId,
        childIds: [],
      },
    },
  };
}

function testSource(
  instanceKey: string,
  sessions: readonly SourceSessionEntry[],
): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey,
      sourceInstanceId: instanceKey,
      displayName: "Test",
    },
    async refresh() {
      return { signature: "stable", sessions, diagnostics: [] };
    },
  };
}
