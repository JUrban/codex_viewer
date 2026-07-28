import type {
  ItemPageQuery,
  ItemPageResponse,
  SessionDetailResponse,
  SessionListQuery,
  SessionListResponse,
  StatusResponse,
  ToolDetailQuery,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type {
  CatalogGeneration,
  Diagnostic,
  SessionDetail,
  SessionId,
  SessionSummary,
  TimelineItem,
} from "../../shared/domain.js";
import type { CatalogDiscovery, CatalogEntry, CodexCatalogSource } from "../codex/catalog-source.js";
import { IdentityResolver } from "../codex/identity-resolver.js";
import type { RolloutDecoder } from "../codex/rollout-decoder.js";
import type { NormalizedSession, SessionNormalizer } from "../codex/session-normalizer.js";
import {
  buildSearchDocument,
  DEFAULT_SEARCH_BUDGET,
  MAX_SEARCH_QUERY_CHARS,
  searchDocuments,
  type SearchBudget,
  type SearchDocument,
} from "../search/search-document.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import {
  fingerprintOf,
  metadataKey,
  sameFingerprint,
  type SessionCacheEntry,
} from "./session-cache.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_ITEM_LIMIT = 50;
const MAX_ITEM_LIMIT = 200;
export const MAX_ITEM_PAGE_BYTES = 4 * 1024 * 1024;

export class RepositoryQueryError extends Error {
  constructor(
    readonly code: "invalid_query" | "stale_generation",
    message: string,
  ) {
    super(message);
  }
}

export interface SessionRepository {
  getStatus(): Promise<StatusResponse>;
  list(query: SessionListQuery): Promise<SessionListResponse>;
  getSession(id: SessionId): Promise<SessionDetailResponse | null>;
  getItems(id: SessionId, query: ItemPageQuery): Promise<ItemPageResponse | null>;
  getToolDetail(
    id: SessionId,
    itemId: string,
    query: ToolDetailQuery,
  ): Promise<ToolDetailResponse | null>;
  refresh(): Promise<CatalogGeneration>;
}

interface RepositorySnapshot {
  generation: CatalogGeneration;
  signature: string;
  mode: CatalogDiscovery["mode"];
  diagnostics: readonly Diagnostic[];
  sessions: ReadonlyMap<SessionId, NormalizedSession>;
  cache: ReadonlyMap<string, SessionCacheEntry>;
  documents: readonly SearchDocument[];
  orderedIds: readonly SessionId[];
}

export class DefaultSessionRepository implements SessionRepository {
  readonly #coordinator = new RefreshCoordinator<RepositorySnapshot>();
  #snapshot: RepositorySnapshot | null = null;

  constructor(
    private readonly source: CodexCatalogSource,
    private readonly decoder: RolloutDecoder,
    private readonly identity: IdentityResolver,
    private readonly normalizer: SessionNormalizer,
    private readonly searchBudget: SearchBudget = DEFAULT_SEARCH_BUDGET,
  ) {}

  async refresh(): Promise<CatalogGeneration> {
    return (await this.#coordinator.run(() => this.#rebuild())).generation;
  }

  async getStatus(): Promise<StatusResponse> {
    const snapshot = await this.#current();
    return {
      available: snapshot.mode !== "unavailable",
      catalogMode: snapshot.mode,
      generation: snapshot.generation,
      sessionCount: snapshot.sessions.size,
      warningCount: snapshot.diagnostics.filter((item) => item.severity !== "info").length +
        [...snapshot.sessions.values()].reduce(
          (count, session) => count + session.detail.warningCount,
          0,
        ),
    };
  }

  async list(query: SessionListQuery): Promise<SessionListResponse> {
    validateListQuery(query);
    const snapshot = await this.#current();
    const offset = query.offset ?? 0;
    assertGeneration(snapshot.generation, query.generation, offset > 0);
    const search = query.q === undefined
      ? { matches: null, partial: false, warnings: [] }
      : { ...searchDocuments(snapshot.documents, query.q, this.searchBudget) };
    const matchedIds: SessionId[] = [];
    const projects = new Map<string, number>();
    for (const id of snapshot.orderedIds) {
      const normalized = snapshot.sessions.get(id);
      if (normalized === undefined) continue;
      const detail = normalized.detail;
      if (!passesFilters(detail, query)) continue;
      if (search.matches !== null && !search.matches.has(id)) continue;
      if (detail.cwd !== null) projects.set(detail.cwd, (projects.get(detail.cwd) ?? 0) + 1);
      matchedIds.push(id);
    }
    const limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const pageIds = matchedIds.slice(offset, offset + limit);
    const entries = pageIds.flatMap((id) => {
      const normalized = snapshot.sessions.get(id);
      return normalized === undefined ? [] : [{
        session: summaryOf(normalized.detail),
        matches: search.matches?.get(id) ?? [],
      }];
    });
    const nextOffset = offset + entries.length;
    return {
      generation: snapshot.generation,
      sessions: entries,
      projects: [...projects.entries()]
        .map(([project, count]) => ({ project, count }))
        .sort((left, right) => left.project.localeCompare(right.project)),
      total: matchedIds.length,
      nextOffset: nextOffset < matchedIds.length ? nextOffset : null,
      hasMore: nextOffset < matchedIds.length,
      partial: search.partial,
      warnings: search.warnings,
    };
  }

  async getSession(id: SessionId): Promise<SessionDetailResponse | null> {
    const snapshot = await this.#current();
    const normalized = snapshot.sessions.get(id);
    return normalized === undefined
      ? null
      : { generation: snapshot.generation, session: cloneDetail(normalized.detail) };
  }

  async getItems(id: SessionId, query: ItemPageQuery): Promise<ItemPageResponse | null> {
    validateItemQuery(query);
    const snapshot = await this.#current();
    assertGeneration(snapshot.generation, query.generation, (query.afterOrdinal ?? 0) > 0);
    const normalized = snapshot.sessions.get(id);
    if (normalized === undefined) return null;
    const after = query.afterOrdinal ?? 0;
    const visible = normalized.items.filter((item) =>
      item.ordinal > after && (query.view === "internal" || item.kind !== "internal"));
    const limit = query.limit ?? DEFAULT_ITEM_LIMIT;
    const items: TimelineItem[] = [];
    let itemBytes = 0;
    for (const item of visible) {
      if (items.length >= limit) break;
      const cloned = cloneItem(item);
      const bytes = Buffer.byteLength(JSON.stringify(cloned), "utf8") + (items.length > 0 ? 1 : 0);
      if (items.length > 0 && itemBytes + bytes > MAX_ITEM_PAGE_BYTES) break;
      items.push(cloned);
      itemBytes += bytes;
    }
    const hasMore = visible.length > items.length;
    return {
      generation: snapshot.generation,
      items,
      nextAfterOrdinal: hasMore ? items.at(-1)?.ordinal ?? null : null,
      hasMore,
      sourceState: normalized.detail.sourceState,
      diagnostics: normalized.detail.diagnostics.map((item) => ({ ...item })),
    };
  }

  async getToolDetail(
    id: SessionId,
    itemId: string,
    query: ToolDetailQuery,
  ): Promise<ToolDetailResponse | null> {
    const snapshot = await this.#current();
    assertGeneration(snapshot.generation, query.generation, true);
    const normalized = snapshot.sessions.get(id);
    const item = normalized?.items.find((candidate) => candidate.id === itemId);
    if (normalized === undefined || item?.kind !== "tool") return null;
    const detail = normalized.toolDetails.get(itemId);
    if (detail === undefined) return null;
    return {
      generation: snapshot.generation,
      sessionId: id,
      itemId,
      input: detail.input,
      output: detail.output,
      truncated: detail.truncated,
    };
  }

  async #current(): Promise<RepositorySnapshot> {
    return this.#coordinator.run(() => this.#rebuild());
  }

  async #rebuild(): Promise<RepositorySnapshot> {
    const discovery = await this.source.discover();
    const signature = discoverySignature(discovery);
    const previous = this.#snapshot;
    if (previous?.signature === signature) return previous;

    const cache = new Map<string, SessionCacheEntry>();
    for (const entry of discovery.entries) {
      const fingerprint = fingerprintOf(entry.descriptor);
      const old = previous?.cache.get(entry.descriptor.canonicalPath);
      const catalogMetadataKey = metadataKey(entry.metadata);
      if (
        old !== undefined &&
        sameFingerprint(old.fingerprint, fingerprint) &&
        old.metadataKey === catalogMetadataKey
      ) {
        cache.set(entry.descriptor.canonicalPath, old);
        continue;
      }
      const rebuilt = await this.#normalizeEntry(entry, fingerprint, catalogMetadataKey);
      cache.set(entry.descriptor.canonicalPath, rebuilt);
    }

    const threadIds = new Map<string, SessionId>();
    for (const entry of cache.values()) {
      if (entry.threadId !== null) threadIds.set(entry.threadId, entry.normalized.detail.id);
    }
    const sessions = linkRelationships(cache, threadIds);
    const documents = [...sessions.values()].map(buildSearchDocument);
    const orderedIds = [...sessions.values()]
      .sort(compareSessions)
      .map((session) => session.detail.id);
    const snapshot: RepositorySnapshot = {
      generation: (previous?.generation ?? 0) + 1,
      signature,
      mode: discovery.mode,
      diagnostics: discovery.diagnostics.map((item) => ({ ...item })),
      sessions,
      cache,
      documents,
      orderedIds,
    };
    this.#snapshot = snapshot;
    return snapshot;
  }

  async #normalizeEntry(
    entry: CatalogEntry,
    fingerprint: ReturnType<typeof fingerprintOf>,
    catalogMetadataKey: string,
  ): Promise<SessionCacheEntry> {
    try {
      const decoded = await this.decoder.decode(entry.descriptor);
      const metadata = this.identity.resolve(decoded, entry.metadata);
      return {
        fingerprint,
        metadataKey: catalogMetadataKey,
        normalized: this.normalizer.normalize(decoded, metadata),
        threadId: metadata.threadId,
      };
    } catch {
      const detail: SessionDetail = {
        id: entry.descriptor.id,
        title: entry.metadata?.title ?? "Unavailable session",
        preview: null,
        cwd: entry.metadata?.cwd ?? null,
        createdAt: entry.metadata?.createdAt ?? null,
        updatedAt: entry.metadata?.updatedAt ?? null,
        archived: entry.metadata?.archived ?? entry.descriptor.archived,
        parentId: null,
        childIds: [],
        sourceState: "unavailable",
        messageCount: 0,
        toolCount: 0,
        warningCount: 1,
        diagnostics: [{
          code: "rollout_unavailable",
          severity: "warning",
          message: "The registered rollout could not be read.",
          ordinal: null,
        }],
        itemCount: 0,
      };
      return {
        fingerprint,
        metadataKey: catalogMetadataKey,
        normalized: { detail, items: [], toolDetails: new Map() },
        threadId: entry.metadata?.threadId ?? null,
      };
    }
  }
}

function discoverySignature(discovery: CatalogDiscovery): string {
  return JSON.stringify({
    mode: discovery.mode,
    diagnostics: discovery.diagnostics,
    entries: discovery.entries.map((entry) => ({
      descriptor: fingerprintOf(entry.descriptor),
      metadata: entry.metadata,
    })),
  });
}

function linkRelationships(
  cache: ReadonlyMap<string, SessionCacheEntry>,
  threadIds: ReadonlyMap<string, SessionId>,
): Map<SessionId, NormalizedSession> {
  const sessions = new Map<SessionId, NormalizedSession>();
  for (const entry of cache.values()) {
    const parentId = entry.normalized.detail.parentId;
    const linkedParent = parentId === null ? null : threadIds.get(parentId) ?? null;
    sessions.set(entry.normalized.detail.id, {
      detail: { ...entry.normalized.detail, parentId: linkedParent, childIds: [] },
      items: entry.normalized.items,
      toolDetails: entry.normalized.toolDetails,
    });
  }
  for (const session of sessions.values()) {
    if (session.detail.parentId === null) continue;
    const parent = sessions.get(session.detail.parentId);
    if (parent !== undefined) parent.detail.childIds.push(session.detail.id);
  }
  return sessions;
}

function compareSessions(left: NormalizedSession, right: NormalizedSession): number {
  return (right.detail.updatedAt ?? right.detail.createdAt ?? "")
    .localeCompare(left.detail.updatedAt ?? left.detail.createdAt ?? "") ||
    left.detail.title.localeCompare(right.detail.title);
}

function passesFilters(detail: SessionDetail, query: SessionListQuery): boolean {
  if (query.project !== undefined && detail.cwd !== query.project) return false;
  if (query.archived !== undefined && detail.archived !== query.archived) return false;
  const timestamp = detail.updatedAt ?? detail.createdAt;
  const instant = timestamp === null ? null : Date.parse(timestamp);
  if (query.from !== undefined && (instant === null || instant < Date.parse(query.from))) return false;
  if (query.to !== undefined && (instant === null || instant > Date.parse(query.to))) return false;
  return true;
}

function validateListQuery(query: SessionListQuery): void {
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
  if (query.offset !== undefined &&
    (!Number.isInteger(query.offset) || query.offset < 0)) {
    throw new RepositoryQueryError("invalid_query", "offset must be a non-negative integer");
  }
  for (const [name, value] of [["from", query.from], ["to", query.to]] as const) {
    if (value !== undefined && !isIsoTimestamp(value)) {
      throw new RepositoryQueryError("invalid_query", `${name} must be an ISO timestamp`);
    }
  }
  if (
    query.from !== undefined &&
    query.to !== undefined &&
    Date.parse(query.from) > Date.parse(query.to)
  ) {
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

function assertGeneration(
  current: CatalogGeneration,
  requested: CatalogGeneration | undefined,
  required: boolean,
): void {
  if (required && requested === undefined) {
    throw new RepositoryQueryError("invalid_query", "generation is required for subsequent pages");
  }
  if (requested !== undefined && requested !== current) {
    throw new RepositoryQueryError("stale_generation", "The catalog generation changed; restart pagination");
  }
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function summaryOf(detail: SessionDetail): SessionSummary {
  const { diagnostics: _diagnostics, itemCount: _itemCount, ...summary } = detail;
  return { ...summary, childIds: [...summary.childIds] };
}

function cloneDetail(detail: SessionDetail): SessionDetail {
  return {
    ...detail,
    childIds: [...detail.childIds],
    diagnostics: detail.diagnostics.map((item) => ({ ...item })),
  };
}

function cloneItem(item: TimelineItem): TimelineItem {
  return { ...item };
}
