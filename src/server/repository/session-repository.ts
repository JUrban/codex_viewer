import type {
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  ItemPageQuery,
  ItemPageResponse,
  SessionDetailResponse,
  SessionListQuery,
  SessionListResponse,
  StatusResponse,
  ToolDetailQuery,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type { CatalogGeneration, SessionId } from "../../shared/domain.js";
import { SessionApiMapper } from "../api/session-api-mapper.js";
import type { SessionSource } from "../source/session-source.js";
import {
  DEFAULT_SEARCH_BUDGET,
  type SearchBudget,
} from "../search/search-document.js";
import {
  CatalogSnapshotStore,
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
  getStatus(): Promise<StatusResponse>;
  list(query: SessionListQuery): Promise<SessionListResponse>;
  getSession(id: SessionId): Promise<SessionDetailResponse | null>;
  getItems(id: SessionId, query: ItemPageQuery): Promise<ItemPageResponse | null>;
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
  refresh(): Promise<CatalogGeneration>;
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
  ) {
    this.#store = new CatalogSnapshotStore(
      sources,
      freshnessMs,
      now,
    );
    this.#queries = new SessionQueryService(searchBudget);
  }

  async refresh(): Promise<CatalogGeneration> {
    return (await this.#store.refresh()).generation;
  }

  async getStatus(): Promise<StatusResponse> {
    return this.#mapper.status(await this.#store.current());
  }

  async list(query: SessionListQuery): Promise<SessionListResponse> {
    const snapshot = await this.#store.current();
    return this.#mapper.list(this.#queries.list(snapshot, query));
  }

  async getSession(id: SessionId): Promise<SessionDetailResponse | null> {
    const snapshot = await this.#store.current();
    const session = this.#queries.session(snapshot, id);
    return session === null ? null : this.#mapper.detail(snapshot.generation, session);
  }

  async getItems(id: SessionId, query: ItemPageQuery): Promise<ItemPageResponse | null> {
    const snapshot = await this.#store.current();
    const result = this.#queries.items(snapshot, id, query);
    return result === null ? null : this.#mapper.itemPage(result);
  }

  async getToolDetail(
    id: SessionId,
    itemId: string,
    query: ToolDetailQuery,
  ): Promise<ToolDetailResponse | null> {
    const snapshot = await this.#store.current();
    const detail = this.#queries.toolDetail(snapshot, id, itemId, query.generation);
    return detail === null
      ? null
      : this.#mapper.toolDetail(snapshot.generation, id, itemId, detail);
  }

  async getDirectiveDetail(
    id: SessionId,
    itemId: string,
    query: DirectiveDetailQuery,
  ): Promise<DirectiveDetailResponse | null> {
    const snapshot = await this.#store.current();
    const detail = this.#queries.directiveDetail(
      snapshot,
      id,
      itemId,
      query.generation,
    );
    return detail === null
      ? null
      : this.#mapper.directiveDetail(snapshot.generation, id, itemId, detail);
  }
}
