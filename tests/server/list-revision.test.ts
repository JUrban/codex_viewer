import { describe, expect, it } from "vitest";
import type {
  DomainSession,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import { buildSearchDocument } from "../../src/server/search/search-document.js";
import type { CatalogSnapshot } from "../../src/server/repository/catalog-snapshot-store.js";
import {
  RepositoryQueryError,
  SessionQueryService,
} from "../../src/server/repository/session-query-service.js";

describe("query-scoped list revisions", () => {
  it("is stable for a canonical query and the same complete ordered ID list", () => {
    const queries = new SessionQueryService();
    const snapshot = snapshotOf([
      normalized("id-a", { title: "Alpha" }),
      normalized("id-b", { title: "Beta" }),
    ]);
    const first = queries.list(snapshot, { limit: 1 });

    expect(first.listRevision).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(queries.list(snapshot, {
      archiveScope: "active",
      limit: 200,
    }).listRevision).toBe(first.listRevision);
    expect(queries.list(snapshot, {
      offset: 1,
      limit: 1,
      listRevision: first.listRevision,
    }).listRevision).toBe(first.listRevision);
    expect(queries.list(snapshot, { q: " ALPHA " }).listRevision).toBe(
      queries.list(snapshot, { q: "alpha" }).listRevision,
    );
    expect(queries.list(snapshot, {
      from: "2026-07-28T00:00:00Z",
    }).listRevision).toBe(queries.list(snapshot, {
      from: "2026-07-28T00:00:00.000+00:00",
    }).listRevision);
  });

  it("binds the canonical query even when two queries return the same IDs", () => {
    const queries = new SessionQueryService();
    const snapshot = snapshotOf([normalized("id-a", { title: "Alpha" })]);

    expect(queries.list(snapshot, {}).listRevision).not.toBe(
      queries.list(snapshot, { project: "/project" }).listRevision,
    );
    expect(queries.list(snapshot, { q: "alpha" }).listRevision).not.toBe(
      queries.list(snapshot, { q: "alp" }).listRevision,
    );
    expect(queries.list(snapshot, {}).listRevision).not.toBe(
      queries.list(snapshot, { archiveScope: "all" }).listRevision,
    );
  });

  it("ignores diagnostics and session content that do not change membership or order", () => {
    const queries = new SessionQueryService();
    const original = normalized("id-a", {
      preview: "old preview",
      messageCount: 1,
      message: "needle old message",
    });
    const changed = normalized("id-a", {
      preview: "new preview",
      messageCount: 2,
      message: "needle new message",
    });
    const first = queries.list(snapshotOf([original]), {});
    const nextSnapshot = snapshotOf([changed], {
      code: "source_recovered",
      severity: "warning",
      message: "diagnostic changed",
      ordinal: null,
    });

    expect(queries.list(nextSnapshot, {}).listRevision).toBe(first.listRevision);
    expect(queries.list(nextSnapshot, { q: "needle" }).listRevision).toBe(
      queries.list(snapshotOf([original]), { q: "needle" }).listRevision,
    );
  });

  it("changes when filters, search membership, IDs, or ordering change", () => {
    const queries = new SessionQueryService();
    const alpha = normalized("id-a", {
      title: "Alpha",
      message: "needle",
    });
    const beta = normalized("id-b", {
      title: "Beta",
      archived: true,
      cwd: "/other",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    const original = snapshotOf([alpha, beta]);

    expect(queries.list(original, {}).listRevision).not.toBe(
      queries.list(original, { archiveScope: "all" }).listRevision,
    );
    expect(queries.list(original, { archiveScope: "all" }).listRevision).not.toBe(
      queries.list(original, {
        archiveScope: "all",
        project: "/project",
      }).listRevision,
    );
    expect(queries.list(original, {
      q: "needle",
    }).listRevision).not.toBe(queries.list(
      snapshotOf([normalized("id-a", { title: "Alpha", message: "gone" }), beta]),
      { q: "needle" },
    ).listRevision);
    expect(queries.list(original, {}).listRevision).not.toBe(
      queries.list(snapshotOf([alpha, normalized("id-c", { title: "Gamma" })]), {})
        .listRevision,
    );
    expect(queries.list(original, { archiveScope: "all" }).listRevision).not.toBe(
      queries.list(snapshotOf([alpha, beta], undefined, ["id-b", "id-a"]), {
        archiveScope: "all",
      }).listRevision,
    );
  });

  it("requires a valid matching revision for later pages and checks supplied first-page revisions", () => {
    const queries = new SessionQueryService();
    const snapshot = snapshotOf([normalized("id-a")]);
    const current = queries.list(snapshot, {}).listRevision;

    expect(() => queries.list(snapshot, { offset: 1 })).toThrowError(
      expect.objectContaining<Partial<RepositoryQueryError>>({
        code: "invalid_query",
      }),
    );
    expect(() => queries.list(snapshot, {
      offset: 1,
      listRevision: "short",
    })).toThrowError(expect.objectContaining<Partial<RepositoryQueryError>>({
      code: "invalid_query",
    }));
    expect(() => queries.list(snapshot, {
      listRevision: "x".repeat(32),
    })).toThrowError(expect.objectContaining<Partial<RepositoryQueryError>>({
      code: "stale_list_revision",
    }));
    expect(() => queries.list(snapshot, {
      offset: 1,
      listRevision: current,
    })).not.toThrow();
  });
});

function normalized(
  id: string,
  overrides: Partial<DomainSession> & { message?: string } = {},
): NormalizedSession {
  const { message = "message", ...sessionOverrides } = overrides;
  const session: DomainSession = {
    id,
    sourceId: id,
    origin: {
      sourceType: "test",
      sourceInstanceId: "test",
      agentName: "Test",
      agentVersion: null,
      formatVersion: null,
    },
    title: id,
    preview: null,
    cwd: "/project",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T01:00:00.000Z",
    archived: false,
    parentId: null,
    childIds: [],
    agent: null,
    messageCount: 1,
    toolCount: 0,
    warningCount: 0,
    diagnostics: [],
    itemCount: 1,
    ...sessionOverrides,
  };
  return {
    session,
    timeline: [{
      kind: "message",
      id: `message-${id}`,
      ordinal: 1,
      timestamp: null,
      role: "user",
      phase: null,
      markdown: message,
    }],
    toolDetails: new Map(),
    directiveDetails: new Map(),
  };
}

function snapshotOf(
  sessions: readonly NormalizedSession[],
  diagnostic?: CatalogSnapshot["diagnostics"][number],
  orderedIds = sessions.map(({ session }) => session.id),
): CatalogSnapshot {
  return {
    signature: diagnostic?.code ?? "snapshot",
    diagnostics: diagnostic === undefined ? [] : [diagnostic],
    sessions: new Map(sessions.map((value) => [
      value.session.id,
      { revision: "r".repeat(32), normalized: value },
    ])),
    documents: sessions.map(buildSearchDocument),
    orderedIds,
    warningCount: diagnostic === undefined ? 0 : 1,
  };
}
