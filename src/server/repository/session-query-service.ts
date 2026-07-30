import type {
  ItemPageQuery,
  SessionListQuery,
} from "../../shared/api-contract.js";
import type { SessionRevision } from "../../shared/domain.js";
import type {
  DomainCatalogGeneration,
  DomainDiagnostic,
  DomainDirectiveDetail,
  DomainSession,
  DomainTimelineRecord,
  DomainToolDetail,
  NormalizedSession,
} from "../domain/session-domain.js";
import {
  DEFAULT_SEARCH_BUDGET,
  MAX_SEARCH_QUERY_CHARS,
  searchDocuments,
  type SearchBudget,
  type SearchMatch,
  type SearchWarning,
} from "../search/search-document.js";
import type { CatalogSnapshot } from "./catalog-snapshot-store.js";
import type { VersionedSession } from "./session-revision-registry.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_ITEM_LIMIT = 50;
const MAX_ITEM_LIMIT = 512;
export const MAX_ITEM_PAGE_BYTES = 4 * 1024 * 1024;

export class RepositoryQueryError extends Error {
  constructor(
    readonly code:
      | "invalid_query"
      | "stale_catalog_generation"
      | "stale_session_revision",
    message: string,
  ) {
    super(message);
  }
}

export interface SessionListResult {
  readonly catalogGeneration: DomainCatalogGeneration;
  readonly sessions: readonly {
    readonly session: DomainSession;
    readonly matches: readonly SearchMatch[];
  }[];
  readonly projects: readonly ProjectFacet[];
  readonly total: number;
  readonly nextOffset: number | null;
  readonly hasMore: boolean;
  readonly partial: boolean;
  readonly warnings: readonly SearchWarning[];
}

export interface ProjectFacet {
  readonly project: string;
  readonly count: number;
}

export interface ItemPageResult {
  readonly sessionRevision: SessionRevision;
  readonly items: readonly DomainTimelineRecord[];
  readonly nextAfterOrdinal: number | null;
  readonly hasMore: boolean;
  readonly diagnostics: readonly DomainDiagnostic[];
}

export class SessionQueryService {
  constructor(private readonly searchBudget: SearchBudget = DEFAULT_SEARCH_BUDGET) {}

  list(snapshot: CatalogSnapshot, query: SessionListQuery): SessionListResult {
    validateListQuery(query);
    const offset = query.offset ?? 0;
    assertCatalogGeneration(
      snapshot.catalogGeneration,
      query.catalogGeneration,
      offset > 0,
    );
    const structurallyEligible: NormalizedSession[] = [];
    const eligibleIds = new Set<string>();
    for (const id of snapshot.orderedIds) {
      const normalized = snapshot.sessions.get(id)?.normalized;
      if (normalized === undefined || !passesStructuralFilters(normalized.session, query)) {
        continue;
      }
      structurallyEligible.push(normalized);
      eligibleIds.add(id);
    }
    const search = query.q === undefined
      ? { matches: null, partial: false, warnings: [] }
      : searchDocuments(
          snapshot.documents.filter((document) => eligibleIds.has(document.sessionId)),
          query.q,
          this.searchBudget,
        );
    const matchedSessions: NormalizedSession[] = [];
    const projects = new Map<string, number>();
    for (const normalized of structurallyEligible) {
      const session = normalized.session;
      if (search.matches !== null && !search.matches.has(session.id)) continue;
      if (session.cwd !== null) projects.set(session.cwd, (projects.get(session.cwd) ?? 0) + 1);
      matchedSessions.push(normalized);
    }
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const sessions = matchedSessions.slice(offset, offset + limit).map((normalized) => ({
      session: normalized.session,
      matches: search.matches?.get(normalized.session.id) ?? [],
    }));
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < matchedSessions.length;
    return {
      catalogGeneration: snapshot.catalogGeneration,
      sessions,
      projects: [...projects.entries()]
        .map(([project, count]) => ({ project, count }))
        .sort((left, right) => left.project.localeCompare(right.project)),
      total: matchedSessions.length,
      nextOffset: hasMore ? nextOffset : null,
      hasMore,
      partial: search.partial,
      warnings: search.warnings,
    };
  }

  session(snapshot: CatalogSnapshot, id: string): VersionedSession | null {
    return snapshot.sessions.get(id) ?? null;
  }

  items(
    snapshot: CatalogSnapshot,
    id: string,
    query: ItemPageQuery,
  ): ItemPageResult | null {
    validateItemQuery(query);
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    assertSessionRevision(versioned.revision, query.sessionRevision);
    const { normalized } = versioned;
    const after = query.afterOrdinal ?? 0;
    const visible = normalized.timeline.filter((item) => item.ordinal > after);
    const limit = query.limit ?? DEFAULT_ITEM_LIMIT;
    const items: DomainTimelineRecord[] = [];
    let itemBytes = 0;
    for (const item of visible) {
      if (items.length >= limit) break;
      const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 ? 1 : 0);
      if (items.length > 0 && itemBytes + bytes > MAX_ITEM_PAGE_BYTES) break;
      items.push(item);
      itemBytes += bytes;
    }
    const hasMore = visible.length > items.length;
    return {
      sessionRevision: versioned.revision,
      items,
      nextAfterOrdinal: hasMore ? items.at(-1)?.ordinal ?? null : null,
      hasMore,
      diagnostics: normalized.session.diagnostics,
    };
  }

  toolDetail(
    snapshot: CatalogSnapshot,
    id: string,
    itemId: string,
    sessionRevision: SessionRevision,
  ): DomainToolDetail | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    assertSessionRevision(versioned.revision, sessionRevision);
    return itemDetail(
      versioned.normalized,
      itemId,
      "tool",
      versioned.normalized.toolDetails,
    );
  }

  directiveDetail(
    snapshot: CatalogSnapshot,
    id: string,
    itemId: string,
    sessionRevision: SessionRevision,
  ): DomainDirectiveDetail | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    assertSessionRevision(versioned.revision, sessionRevision);
    return itemDetail(
      versioned.normalized,
      itemId,
      "directive",
      versioned.normalized.directiveDetails,
    );
  }
}

function itemDetail<T>(
  normalized: NormalizedSession,
  itemId: string,
  kind: DomainTimelineRecord["kind"],
  details: ReadonlyMap<string, T>,
): T | null {
  const item = normalized.timeline.find((candidate) => candidate.id === itemId);
  if (item?.kind !== kind) return null;
  return details.get(itemId) ?? null;
}

function passesStructuralFilters(session: DomainSession, query: SessionListQuery): boolean {
  const archiveScope = query.archiveScope ?? "active";
  if (query.project !== undefined && session.cwd !== query.project) return false;
  if (archiveScope !== "all" && session.archived !== (archiveScope === "archived")) {
    return false;
  }
  const timestamp = session.updatedAt ?? session.createdAt;
  const instant = timestamp === null ? null : Date.parse(timestamp);
  if (query.from !== undefined && (instant === null || instant < Date.parse(query.from))) return false;
  if (query.to !== undefined && (instant === null || instant > Date.parse(query.to))) return false;
  return true;
}

function validateListQuery(query: SessionListQuery): void {
  if (
    query.archiveScope !== undefined &&
    query.archiveScope !== "active" &&
    query.archiveScope !== "archived" &&
    query.archiveScope !== "all"
  ) {
    throw new RepositoryQueryError(
      "invalid_query",
      "archiveScope must be active, archived, or all",
    );
  }
  if (query.q !== undefined) {
    const trimmed = query.q.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_SEARCH_QUERY_CHARS) {
      throw new RepositoryQueryError("invalid_query", `q must contain 1-${MAX_SEARCH_QUERY_CHARS} characters`);
    }
  }
  if (query.project !== undefined && (query.project.length === 0 || query.project.length > 4_096)) {
    throw new RepositoryQueryError("invalid_query", "project is invalid");
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIST_LIMIT)) {
    throw new RepositoryQueryError("invalid_query", `limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  if (query.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0)) {
    throw new RepositoryQueryError("invalid_query", "offset must be a non-negative integer");
  }
  for (const [name, value] of [["from", query.from], ["to", query.to]] as const) {
    if (value !== undefined && !isIsoTimestamp(value)) {
      throw new RepositoryQueryError("invalid_query", `${name} must be an ISO timestamp`);
    }
  }
  if (query.from !== undefined && query.to !== undefined && Date.parse(query.from) > Date.parse(query.to)) {
    throw new RepositoryQueryError("invalid_query", "from must not be later than to");
  }
}

function validateItemQuery(query: ItemPageQuery): void {
  if (query.afterOrdinal !== undefined &&
    (!Number.isInteger(query.afterOrdinal) || query.afterOrdinal < 0)) {
    throw new RepositoryQueryError("invalid_query", "afterOrdinal must be a non-negative integer");
  }
  if (query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_ITEM_LIMIT)) {
    throw new RepositoryQueryError("invalid_query", `limit must be between 1 and ${MAX_ITEM_LIMIT}`);
  }
}

function assertCatalogGeneration(
  current: DomainCatalogGeneration,
  requested: DomainCatalogGeneration | undefined,
  required: boolean,
): void {
  if (required && requested === undefined) {
    throw new RepositoryQueryError(
      "invalid_query",
      "catalogGeneration is required for subsequent pages",
    );
  }
  if (requested !== undefined && requested !== current) {
    throw new RepositoryQueryError(
      "stale_catalog_generation",
      "The catalog generation changed; restart pagination",
    );
  }
}

function assertSessionRevision(
  current: SessionRevision,
  requested: SessionRevision,
): void {
  if (requested !== current) {
    throw new RepositoryQueryError(
      "stale_session_revision",
      "The session revision changed; restart pagination",
    );
  }
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
