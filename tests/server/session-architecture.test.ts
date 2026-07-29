import { describe, expect, it, vi } from "vitest";
import { SessionApiMapper } from "../../src/server/api/session-api-mapper.js";
import { IdentityResolver } from "../../src/server/codex/identity-resolver.js";
import { DefaultSessionNormalizer } from "../../src/server/codex/session-normalizer.js";
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

const session: DomainSession = {
  id: "session-one",
  sourceId: "private-source-id",
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
  it("maps domain values exactly without leaking private summary fields or mutable references", () => {
    const mapper = new SessionApiMapper();
    const detail = mapper.detail(7, session);
    const summary = mapper.summary(session);
    const item = mapper.timelineItem(timeline[0]!);

    expect(summary).toEqual({
      id: "session-one",
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

  it("degrades expected rollout I/O failures but propagates unknown decoder failures", async () => {
    const descriptor = {
      id: "session-one",
      canonicalPath: "/gone/session.jsonl",
      archived: false,
      size: 1,
      mtimeMs: 1,
      device: 1,
      inode: 1,
    };
    const source = {
      discover: vi.fn(async () => ({
        mode: "jsonl" as const,
        entries: [{
          descriptor,
          metadata: {
            threadId: "session-one",
            title: `${"Unavailable title ".repeat(10)}\nignored`,
            cwd: null,
            createdAt: null,
            updatedAt: null,
            parentThreadId: null,
            archived: false,
          },
        }],
        diagnostics: [],
      })),
    };
    const unavailable = new CatalogSnapshotStore(
      source,
      {
        decode: vi.fn(async () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }),
      },
      new IdentityResolver(),
      new DefaultSessionNormalizer(),
    );
    const unavailableSession = (await unavailable.current()).sessions.get("session-one")?.session;
    expect(unavailableSession)
      .toMatchObject({ sourceState: "unavailable", warningCount: 1 });
    expect(unavailableSession?.title).toHaveLength(80);
    expect(unavailableSession?.title).not.toContain("\n");

    const broken = new CatalogSnapshotStore(
      source,
      { decode: vi.fn(async () => { throw new Error("decoder invariant"); }) },
      new IdentityResolver(),
      new DefaultSessionNormalizer(),
    );
    await expect(broken.current()).rejects.toThrow("decoder invariant");
  });
});

function snapshotOf(value: NormalizedSession): CatalogSnapshot {
  return {
    generation: 3,
    signature: "snapshot",
    mode: "jsonl",
    diagnostics: [],
    sessions: new Map([[value.session.id, value]]),
    cache: new Map(),
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
