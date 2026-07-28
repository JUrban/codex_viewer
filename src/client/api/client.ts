import type {
  ApiError,
  ItemPageQuery,
  ItemPageResponse,
  SessionDetailResponse,
  SessionListQuery,
  SessionListResponse,
  StatusResponse,
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

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    let body: ApiError | undefined;
    try {
      body = (await response.json()) as ApiError;
    } catch {
      // The API normally returns JSON, but the client still fails safely if a proxy does not.
    }
    throw new ApiClientError(
      response.status,
      body?.error.code ?? "request_failed",
      body?.error.message ?? `Request failed (${response.status})`,
    );
  }
  return response.json() as Promise<T>;
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const api = {
  status: (signal?: AbortSignal) => request<StatusResponse>("/api/v1/status", signal),
  sessions: (query: SessionListQuery, signal?: AbortSignal) =>
    request<SessionListResponse>(
      `/api/v1/sessions${queryString({
        q: query.q,
        project: query.project,
        from: query.from,
        to: query.to,
        archived: query.archived,
        limit: query.limit,
      })}`,
      signal,
    ),
  session: (id: string, signal?: AbortSignal) =>
    request<SessionDetailResponse>(`/api/v1/sessions/${encodeURIComponent(id)}`, signal),
  items: (id: string, query: ItemPageQuery, signal?: AbortSignal) =>
    request<ItemPageResponse>(
      `/api/v1/sessions/${encodeURIComponent(id)}/items${queryString({
        afterOrdinal: query.afterOrdinal,
        limit: query.limit,
        view: query.view,
        generation: query.generation,
      })}`,
      signal,
    ),
  tool: (sessionId: string, itemId: string, generation: number, signal?: AbortSignal) =>
    request<ToolDetailResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/tool${queryString({ generation })}`,
      signal,
    ),
};
