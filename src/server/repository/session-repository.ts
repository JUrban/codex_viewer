import type {
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  ItemPageQuery,
  ItemPageResponse,
  SessionDetailResponse,
  SessionListQuery,
  SessionListResponse,
  ToolDetailQuery,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type { SessionId } from "../../shared/domain.js";
import type { DomainAgentInteraction } from "../domain/session-domain.js";
import { SessionApiMapper } from "../api/session-api-mapper.js";
import type { SessionSource } from "../source/session-source.js";
import {
  DEFAULT_SEARCH_BUDGET,
  type SearchBudget,
} from "../search/search-document.js";
import {
  CatalogSnapshotStore,
  type CatalogSnapshotStoreDependencies,
  DEFAULT_CATALOG_FRESHNESS_MS,
} from "./catalog-snapshot-store.js";
import {
  MAX_ITEM_PAGE_BYTES,
  RepositoryQueryError,
  SessionQueryService,
} from "./session-query-service.js";

export {
  DEFAULT_CATALOG_FRESHNESS_MS,
  MAX_ITEM_PAGE_BYTES,
  RepositoryQueryError,
};

export interface SessionRepository {
  list(query: SessionListQuery): Promise<SessionListResponse>;
  getSession(
    id: SessionId,
  ): Promise<RepositorySessionDetailResponse | null>;
  getItems(id: SessionId, query: ItemPageQuery): Promise<RepositoryItemPageResponse | null>;
  getLiveSession(id: SessionId, cursor: import("../../shared/api-contract.js").TimelineCursor):
    Promise<RepositoryLiveSessionSnapshot | null>;
  getToolDetail(
    id: SessionId,
    itemId: string,
    query: ToolDetailQuery,
  ): Promise<ToolDetailResponse | null>;
  getDirectiveDetail(
    id: SessionId,
    itemId: string,
    query: DirectiveDetailQuery,
  ): Promise<DirectiveDetailResponse | null>;
  refresh(): Promise<void>;
  getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null>;
}

export type RepositorySessionDetailResponse = Omit<SessionDetailResponse, "interaction" | "liveRevision">;
export type RepositoryItemPageResponse = Omit<ItemPageResponse, "interaction" | "liveRevision">;

export interface RepositoryLiveSessionSnapshot {
  readonly session: SessionDetailResponse["session"];
  readonly cursor: import("../../shared/api-contract.js").TimelineCursor;
  readonly hasMore: boolean;
  readonly interactionSession: InteractionSessionSnapshot;
}

export interface InteractionSessionSnapshot {
  readonly archived: boolean;
  readonly interaction: DomainAgentInteraction | null;
}

export class DefaultSessionRepository implements SessionRepository {
  readonly #store: CatalogSnapshotStore;
  readonly #queries: SessionQueryService;
  readonly #mapper = new SessionApiMapper();

  constructor(
    sources: readonly SessionSource[],
    searchBudget: SearchBudget = DEFAULT_SEARCH_BUDGET,
    freshnessMs = DEFAULT_CATALOG_FRESHNESS_MS,
    now: () => number = performance.now.bind(performance),
    storeDependencies?: CatalogSnapshotStoreDependencies,
  ) {
    this.#store = new CatalogSnapshotStore(
      sources,
      freshnessMs,
      now,
      storeDependencies,
    );
    this.#queries = new SessionQueryService(searchBudget);
  }

  async refresh(): Promise<void> {
    await this.#store.refresh();
  }

  async list(query: SessionListQuery): Promise<SessionListResponse> {
    const snapshot = query.fresh ? await this.#store.refresh() : await this.#store.current();
    return this.#mapper.list(this.#queries.list(snapshot, query));
  }

  async getSession(
    id: SessionId,
  ): Promise<RepositorySessionDetailResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.session(snapshot, id);
    return result === null
      ? null
      : this.#mapper.detail(result);
  }

  async getItems(
    id: SessionId,
    query: ItemPageQuery,
  ): Promise<RepositoryItemPageResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.items(snapshot, id, query);
    return result === null ? null : this.#mapper.itemPage(result);
  }

  async getLiveSession(
    id: SessionId,
    cursor: import("../../shared/api-contract.js").TimelineCursor,
  ): Promise<RepositoryLiveSessionSnapshot | null> {
    const snapshot = await this.#store.current();
    const context = this.#queries.live(snapshot, id, cursor);
    if (context === null) return null;
    const normalized = snapshot.sessions.get(id)!.normalized;
    return {
      session: this.#mapper.sessionDetail(context.session),
      cursor: context.cursor,
      hasMore: context.hasMore,
      interactionSession: {
        archived: normalized.session.archived,
        interaction: normalized.interaction ?? null,
      },
    };
  }

  async getToolDetail(
    id: SessionId,
    itemId: string,
    query: ToolDetailQuery,
  ): Promise<ToolDetailResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.toolDetail(
      snapshot,
      id,
      itemId,
      query,
    );
    return result === null
      ? null
      : this.#mapper.toolDetail(itemId, result);
  }

  async getDirectiveDetail(
    id: SessionId,
    itemId: string,
    query: DirectiveDetailQuery,
  ): Promise<DirectiveDetailResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.directiveDetail(
      snapshot,
      id,
      itemId,
      query,
    );
    return result === null
      ? null
      : this.#mapper.directiveDetail(itemId, result);
  }

  async getInteractionSession(id: SessionId): Promise<InteractionSessionSnapshot | null> {
    const snapshot = await this.#store.current();
    const normalized = snapshot.sessions.get(id)?.normalized;
    return normalized === undefined
      ? null
      : {
          archived: normalized.session.archived,
          interaction: normalized.interaction ?? null,
        };
  }
}
