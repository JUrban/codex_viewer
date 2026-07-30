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
  sourceState: "partial",
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
    const detail = mapper.detail(7, session);
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
      sourceState: "partial",
      messageCount: 1,
      toolCount: 0,
      warningCount: 1,
    });
    expect(summary).not.toHaveProperty("sourceId");
    expect(detail).toEqual({
      generation: 7,
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
    });

    summary.childIds.push("mutated");
    detail.session.diagnostics[0]!.message = "mutated";
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

  it("keeps query validation, filtering, facets, paging, and generation checks pure", () => {
    const queries = new SessionQueryService();
    const snapshot = snapshotOf(normalized);
    const first = queries.list(snapshot, { project: "/project", limit: 1 });
    expect(first).toMatchObject({
      generation: 3,
      total: 1,
      hasMore: false,
      projects: [{ project: "/project", count: 1 }],
    });
    expect(queries.items(snapshot, "session-one", {})?.items).toEqual(timeline);
    expect(() => queries.list(snapshot, { offset: 1 })).toThrowError(
      expect.objectContaining<Partial<RepositoryQueryError>>({ code: "invalid_query" }),
    );
    expect(() => queries.list(snapshot, { generation: 2 })).toThrowError(
      expect.objectContaining<Partial<RepositoryQueryError>>({ code: "stale_generation" }),
    );
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
      sourceEntry("child", "parent", "Source A child"),
    ]);
    const sourceB = testSource("source-b", [
      sourceEntry("parent", null, "Source B parent"),
      sourceEntry("child", "missing-in-source-b", "Source B child"),
    ]);
    const first = await new CatalogSnapshotStore([sourceA, sourceB]).current();
    const reordered = await new CatalogSnapshotStore([sourceB, sourceA]).current();

    expect(first.signature).toBe(reordered.signature);
    expect([...first.sessions.keys()].sort()).toEqual(
      [...reordered.sessions.keys()].sort(),
    );
    const byTitle = new Map(
      [...first.sessions.values()].map((value) => [value.session.title, value.session]),
    );
    expect(byTitle.get("Source A parent")?.id)
      .not.toBe(byTitle.get("Source B parent")?.id);
    expect(byTitle.get("Source A child")?.parentId)
      .toBe(byTitle.get("Source A parent")?.id);
    expect(byTitle.get("Source B child")?.parentId).toBeNull();
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
  return {
    generation: 3,
    signature: "snapshot",
    diagnostics: [],
    sessions: new Map([[value.session.id, value]]),
    documents: [{
      sessionId: value.session.id,
      title: value.session.title,
      agentTerms: [],
      cwd: value.session.cwd ?? "",
      messages: [],
    }],
    orderedIds: [value.session.id],
    warningCount: 1,
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
