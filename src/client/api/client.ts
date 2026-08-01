import type {
  ApiError,
  DirectiveDetailQuery,
  DirectiveDetailResponse,
  ItemPageQuery,
  ItemPageResponse,
  SessionDetailQuery,
  SessionDetailResponse,
  SessionListQuery,
  SessionListResponse,
  SessionReadCursor,
  ToolDetailQuery,
  ToolDetailResponse,
} from "../../shared/api-contract";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(
  path: string,
  signal?: AbortSignal,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...init.headers },
    signal,
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // The API normally returns JSON, but the client still fails safely if a proxy does not.
    }
    const apiError = parseApiError(body);
    throw new ApiClientError(
      response.status,
      apiError?.code ?? "request_failed",
      apiError?.message ?? `Request failed (${response.status})`,
    );
  }
  return response.status === 204
    ? undefined as T
    : response.json() as Promise<T>;
}

function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseApiError(value: unknown): ApiError["error"] | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = value.error;
  if (typeof error !== "object" || error === null) return null;
  if (!("code" in error) || typeof error.code !== "string") return null;
  if (!("message" in error) || typeof error.message !== "string") return null;
  return { code: error.code, message: error.message };
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function cursorValues(cursor: SessionReadCursor | undefined) {
  return cursor === undefined
    ? {}
    : {
        sessionRevision: cursor.sessionRevision,
        throughOrdinal: cursor.throughOrdinal,
        timelinePrefixRevision: cursor.timelinePrefixRevision,
      };
}

function cursorQuery(cursor: SessionReadCursor | undefined): string {
  return queryString(cursorValues(cursor));
}

export const api = {
  sessions: (query: SessionListQuery, signal?: AbortSignal) =>
    request<SessionListResponse>(
      `/api/v1/sessions${queryString({
        q: query.q,
        project: query.project,
        from: query.from,
        to: query.to,
        archiveScope: query.archiveScope,
        offset: query.offset,
        limit: query.limit,
        listRevision: query.listRevision,
      })}`,
      signal,
    ),
  session: (
    id: string,
    query: SessionDetailQuery = {},
    signal?: AbortSignal,
  ) =>
    request<SessionDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(id)}${cursorQuery(query.cursor)}`,
      signal,
    ),
  items: (id: string, query: ItemPageQuery, signal?: AbortSignal) =>
    request<ItemPageResponse>(
      `/api/v1/sessions/${encodeURIComponent(id)}/items${queryString({
        limit: query.limit,
        ...cursorValues(query.cursor),
      })}`,
      signal,
    ),
  tool: (
    sessionId: string,
    itemId: string,
    query: ToolDetailQuery,
    signal?: AbortSignal,
  ) =>
    request<ToolDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/tool${cursorQuery(query.cursor)}`,
      signal,
    ),
  directive: (
    sessionId: string,
    itemId: string,
    query: DirectiveDetailQuery,
    signal?: AbortSignal,
  ) =>
    request<DirectiveDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/directive${cursorQuery(query.cursor)}`,
      signal,
    ),
  sendMessage: (sessionId: string, message: string, signal?: AbortSignal) =>
    postJson<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { message },
      signal,
    ),
  interrupt: (sessionId: string, signal?: AbortSignal) =>
    postJson<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      {},
      signal,
    ),
  sendEscape: (sessionId: string, signal?: AbortSignal) =>
    postJson<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/keys`,
      { key: "escape" },
      signal,
    ),
};
