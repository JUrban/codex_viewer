import type {
  DirectiveDetailQuery,
  ItemPageQuery,
  SessionDetailQuery,
  SessionListQuery,
  SessionReadCursor,
  ToolDetailQuery,
} from "../../shared/api-contract.js";
import type {
  ListRevision,
  SessionRevision,
  TimelinePrefixRevision,
} from "../../shared/domain.js";
import type {
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
import {
  isSessionRevision,
  type VersionedSession,
} from "./session-revision-registry.js";
import {
  canonicalListQuery,
  createProcessListRevisionFactory,
  isListRevision,
  type ListRevisionFactory,
} from "./list-revision.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_ITEM_LIMIT = 50;
const MAX_ITEM_LIMIT = 512;
export const MAX_ITEM_PAGE_BYTES = 4 * 1024 * 1024;

export class RepositoryQueryError extends Error {
  constructor(
    readonly code:
      | "invalid_query"
      | "stale_list_revision"
      | "stale_timeline_prefix",
    message: string,
  ) {
    super(message);
  }
}

export interface SessionListResult {
  readonly listRevision: ListRevision;
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

export interface SessionReadContextResult {
  readonly sessionRevision: SessionRevision;
  readonly session: DomainSession;
  readonly throughOrdinal: number;
  readonly timelinePrefixRevision: TimelinePrefixRevision;
  readonly hasMore: boolean;
}

export interface ItemPageResult {
  readonly context: SessionReadContextResult;
  readonly items: readonly DomainTimelineRecord[];
}

export interface ToolDetailResult {
  readonly context: SessionReadContextResult;
  readonly detail: DomainToolDetail;
}

export interface DirectiveDetailResult {
  readonly context: SessionReadContextResult;
  readonly detail: DomainDirectiveDetail;
}

export class SessionQueryService {
  constructor(
    private readonly searchBudget: SearchBudget = DEFAULT_SEARCH_BUDGET,
    private readonly createListRevision: ListRevisionFactory =
      createProcessListRevisionFactory(),
  ) {}

  list(snapshot: CatalogSnapshot, query: SessionListQuery): SessionListResult {
    validateListQuery(query);
    const offset = query.offset ?? 0;
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
    const listRevision = this.createListRevision(
      canonicalListQuery(query),
      matchedSessions.map(({ session }) => session.id),
    );
    assertListRevision(listRevision, query.listRevision, offset > 0);
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const sessions = matchedSessions.slice(offset, offset + limit).map((normalized) => ({
      session: normalized.session,
      matches: search.matches?.get(normalized.session.id) ?? [],
    }));
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < matchedSessions.length;
    return {
      listRevision,
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

  session(
    snapshot: CatalogSnapshot,
    id: string,
    query: SessionDetailQuery = {},
  ): SessionReadContextResult | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const boundary = resolveReadBoundary(versioned, query.cursor);
    return readContext(versioned, boundary);
  }

  items(
    snapshot: CatalogSnapshot,
    id: string,
    query: ItemPageQuery,
  ): ItemPageResult | null {
    validateItemQuery(query);
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const requestedBoundary = resolveReadBoundary(versioned, query.cursor);
    const { normalized } = versioned;
    const after = requestedBoundary.throughOrdinal;
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
    const boundary = items.length === 0
      ? requestedBoundary
      : versioned.timelinePrefixIndex.boundaryAt(
        normalized.timeline,
        items.at(-1)!.ordinal,
      )!;
    return {
      context: readContext(versioned, boundary),
      items,
    };
  }

  toolDetail(
    snapshot: CatalogSnapshot,
    id: string,
    itemId: string,
    query: ToolDetailQuery,
  ): ToolDetailResult | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const boundary = resolveReadBoundary(versioned, query.cursor);
    const detail = itemDetail(
      versioned.normalized,
      itemId,
      "tool",
      versioned.normalized.toolDetails,
    );
    return detail === null
      ? null
      : { context: readContext(versioned, boundary), detail };
  }

  directiveDetail(
    snapshot: CatalogSnapshot,
    id: string,
    itemId: string,
    query: DirectiveDetailQuery,
  ): DirectiveDetailResult | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const boundary = resolveReadBoundary(versioned, query.cursor);
    const detail = itemDetail(
      versioned.normalized,
      itemId,
      "directive",
      versioned.normalized.directiveDetails,
    );
    return detail === null
      ? null
      : { context: readContext(versioned, boundary), detail };
  }
}

function resolveReadBoundary(
  versioned: VersionedSession,
  cursor: SessionReadCursor | undefined,
) {
  const { normalized, timelinePrefixIndex } = versioned;
  if (cursor === undefined) {
    return timelinePrefixIndex.boundaryAt(normalized.timeline, 0)!;
  }
  validateReadCursor(cursor);
  const boundary = timelinePrefixIndex.boundaryAt(
    normalized.timeline,
    cursor.throughOrdinal,
  );
  if (
    boundary === null ||
    boundary.throughOrdinal !== cursor.throughOrdinal ||
    !timelinePrefixIndex.matches(
      normalized.timeline,
      boundary,
      cursor.timelinePrefixRevision,
    )
  ) {
    throw new RepositoryQueryError(
      "stale_timeline_prefix",
      "The loaded timeline is no longer a prefix of this session",
    );
  }
  return boundary;
}

function readContext(
  versioned: VersionedSession,
  boundary: {
    throughOrdinal: number;
    timelinePrefixRevision: TimelinePrefixRevision;
  },
): SessionReadContextResult {
  return {
    sessionRevision: versioned.revision,
    session: versioned.normalized.session,
    throughOrdinal: boundary.throughOrdinal,
    timelinePrefixRevision: boundary.timelinePrefixRevision,
    hasMore:
      boundary.throughOrdinal <
      (versioned.normalized.timeline.at(-1)?.ordinal ?? 0),
  };
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
  if (query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_ITEM_LIMIT)) {
    throw new RepositoryQueryError("invalid_query", `limit must be between 1 and ${MAX_ITEM_LIMIT}`);
  }
}

function validateReadCursor(cursor: SessionReadCursor): void {
  if (!isSessionRevision(cursor.sessionRevision)) {
    throw new RepositoryQueryError(
      "invalid_query",
      "sessionRevision is invalid",
    );
  }
  if (
    !Number.isSafeInteger(cursor.throughOrdinal) ||
    cursor.throughOrdinal < 0
  ) {
    throw new RepositoryQueryError(
      "invalid_query",
      "throughOrdinal must be a non-negative integer",
    );
  }
  if (!/^[A-Za-z0-9_-]{32}$/.test(cursor.timelinePrefixRevision)) {
    throw new RepositoryQueryError(
      "invalid_query",
      "timelinePrefixRevision is invalid",
    );
  }
}

function assertListRevision(
  current: ListRevision,
  requested: ListRevision | undefined,
  required: boolean,
): void {
  if (required && requested === undefined) {
    throw new RepositoryQueryError(
      "invalid_query",
      "listRevision is required for subsequent pages",
    );
  }
  if (requested !== undefined && !isListRevision(requested)) {
    throw new RepositoryQueryError("invalid_query", "listRevision is invalid");
  }
  if (requested !== undefined && requested !== current) {
    throw new RepositoryQueryError(
      "stale_list_revision",
      "The session list changed; restart pagination",
    );
  }
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
