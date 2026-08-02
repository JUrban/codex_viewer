import type {
  DirectiveDetailQuery,
  ItemPageQuery,
  SessionListQuery,
  TimelineCursor,
  ToolDetailQuery,
} from "../../shared/api-contract.js";
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
import type { IndexedSession } from "./timeline-prefix-registry.js";
import {
  canonicalListQuery,
  createProcessListRevisionFactory,
  type ListRevisionFactory,
} from "./list-revision.js";
import { OpaqueCursorCodec } from "./opaque-cursor.js";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 300;
const DEFAULT_ITEM_LIMIT = 100;
const MAX_ITEM_LIMIT = 300;
export const MAX_ITEM_PAGE_BYTES = 4 * 1024 * 1024;

export class RepositoryQueryError extends Error {
  constructor(
    readonly code:
      | "invalid_query"
      | "stale_list_cursor"
      | "timeline_changed",
    message: string,
  ) {
    super(message);
  }
}

export interface SessionListResult {
  readonly sessions: readonly {
    readonly session: DomainSession;
    readonly matches: readonly SearchMatch[];
  }[];
  readonly projects: readonly ProjectFacet[];
  readonly total: number;
  readonly nextCursor: import("../../shared/api-contract.js").ListCursor | null;
  readonly partial: boolean;
  readonly warnings: readonly SearchWarning[];
}

export interface ProjectFacet {
  readonly project: string;
  readonly count: number;
}

export interface TimelinePageContext {
  readonly session: DomainSession;
  readonly cursor: TimelineCursor;
  readonly hasMore: boolean;
}

export interface ItemPageResult {
  readonly context: TimelinePageContext;
  readonly items: readonly DomainTimelineRecord[];
}

export interface ToolDetailResult {
  readonly detail: DomainToolDetail;
}

export interface DirectiveDetailResult {
  readonly detail: DomainDirectiveDetail;
}

export class SessionQueryService {
  constructor(
    private readonly searchBudget: SearchBudget = DEFAULT_SEARCH_BUDGET,
    private readonly createListRevision: ListRevisionFactory =
      createProcessListRevisionFactory(),
    private readonly cursors = new OpaqueCursorCodec(),
  ) {}

  list(snapshot: CatalogSnapshot, query: SessionListQuery): SessionListResult {
    validateListQuery(query);
    const cursorResult = query.cursor === undefined
      ? null
      : this.cursors.decodeList(query.cursor);
    if (cursorResult?.kind === "malformed") {
      throw new RepositoryQueryError("invalid_query", "cursor is malformed");
    }
    if (cursorResult?.kind === "untrusted") {
      throw new RepositoryQueryError(
        "stale_list_cursor",
        "The session list cursor is no longer valid; restart pagination",
      );
    }
    const decodedCursor = cursorResult?.kind === "valid" ? cursorResult.value : null;
    if (decodedCursor !== null && !this.cursors.listQueryMatches(decodedCursor, query)) {
      throw new RepositoryQueryError("invalid_query", "cursor does not match the list query");
    }
    const offset = decodedCursor?.o ?? 0;
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
    if (decodedCursor !== null && decodedCursor.r !== listRevision) {
      throw new RepositoryQueryError(
        "stale_list_cursor",
        "The session list changed; restart pagination",
      );
    }
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const sessions = matchedSessions.slice(offset, offset + limit).map((normalized) => ({
      session: normalized.session,
      matches: search.matches?.get(normalized.session.id) ?? [],
    }));
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < matchedSessions.length;
    return {
      sessions,
      projects: [...projects.entries()]
        .map(([project, count]) => ({ project, count }))
        .sort((left, right) => left.project.localeCompare(right.project)),
      total: matchedSessions.length,
      nextCursor: hasMore
        ? this.cursors.encodeList(query, nextOffset, listRevision)
        : null,
      partial: search.partial,
      warnings: search.warnings,
    };
  }

  session(snapshot: CatalogSnapshot, id: string): DomainSession | null {
    const versioned = snapshot.sessions.get(id);
    return versioned?.normalized.session ?? null;
  }

  items(
    snapshot: CatalogSnapshot,
    id: string,
    query: ItemPageQuery,
  ): ItemPageResult | null {
    validateItemQuery(query);
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const requestedBoundary = this.#resolveReadBoundary(id, versioned, query.cursor);
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
      context: this.#readContext(id, versioned, boundary),
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
    const boundary = this.#resolveReadBoundary(id, versioned, query.cursor);
    const detail = itemDetail(
      versioned.normalized,
      itemId,
      "tool",
      versioned.normalized.toolDetails,
    );
    if (detail === null) return null;
    assertItemConfirmed(versioned.normalized, itemId, boundary.throughOrdinal);
    return { detail };
  }

  directiveDetail(
    snapshot: CatalogSnapshot,
    id: string,
    itemId: string,
    query: DirectiveDetailQuery,
  ): DirectiveDetailResult | null {
    const versioned = snapshot.sessions.get(id);
    if (versioned === undefined) return null;
    const boundary = this.#resolveReadBoundary(id, versioned, query.cursor);
    const detail = itemDetail(
      versioned.normalized,
      itemId,
      "directive",
      versioned.normalized.directiveDetails,
    );
    if (detail === null) return null;
    assertItemConfirmed(versioned.normalized, itemId, boundary.throughOrdinal);
    return { detail };
  }

  #resolveReadBoundary(
    id: string,
    versioned: IndexedSession,
    cursor: TimelineCursor | undefined,
  ) {
    const { normalized, timelinePrefixIndex } = versioned;
    if (cursor === undefined) return timelinePrefixIndex.boundaryAt(normalized.timeline, 0)!;
    const cursorResult = this.cursors.decodeTimeline(cursor);
    if (cursorResult.kind === "malformed") {
      throw new RepositoryQueryError("invalid_query", "cursor is malformed");
    }
    if (cursorResult.kind === "untrusted") {
      throw new RepositoryQueryError(
        "timeline_changed",
        "The timeline cursor is no longer valid; reload this session",
      );
    }
    const decoded = cursorResult.value;
    if (decoded.s !== id) throw new RepositoryQueryError("invalid_query", "cursor belongs to another session");
    const boundary = timelinePrefixIndex.boundaryAt(normalized.timeline, decoded.o);
    if (boundary === null || boundary.throughOrdinal !== decoded.o ||
      !timelinePrefixIndex.matches(normalized.timeline, boundary, decoded.p)) {
      throw new RepositoryQueryError(
        "timeline_changed",
        "The loaded timeline is no longer a prefix of this session",
      );
    }
    return boundary;
  }

  #readContext(
    id: string,
    versioned: IndexedSession,
    boundary: { throughOrdinal: number; timelinePrefixRevision: string },
  ): TimelinePageContext {
    return {
      session: versioned.normalized.session,
      cursor: this.cursors.encodeTimeline(
        id,
        boundary.throughOrdinal,
        boundary.timelinePrefixRevision,
      ),
      hasMore: boundary.throughOrdinal <
        (versioned.normalized.timeline.at(-1)?.ordinal ?? 0),
    };
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

function assertItemConfirmed(
  normalized: NormalizedSession,
  itemId: string,
  throughOrdinal: number,
): void {
  const item = normalized.timeline.find((candidate) => candidate.id === itemId);
  if (item !== undefined && item.ordinal > throughOrdinal) {
    throw new RepositoryQueryError(
      "invalid_query",
      "cursor does not confirm the requested item",
    );
  }
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
  if (query.fresh !== undefined && typeof query.fresh !== "boolean") {
    throw new RepositoryQueryError("invalid_query", "fresh must be a boolean");
  }
  if (query.fresh && query.cursor !== undefined) {
    throw new RepositoryQueryError("invalid_query", "fresh cannot be used with cursor");
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

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
