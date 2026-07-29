import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  InjectedContextDetailQuery,
  ItemPageQuery,
  SessionListQuery,
  ToolDetailQuery,
} from "../../shared/api-contract.js";
import {
  RepositoryQueryError,
  type SessionRepository,
} from "../repository/session-repository.js";
import { sendJson, type ApiRouter } from "./router.js";

const API_ROOT = "/api/v1";

export function createApiRouter(repository: SessionRepository): ApiRouter {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    const headOnly = request.method === "HEAD";

    try {
      if (url.pathname === `${API_ROOT}/status`) {
        sendJson(response, 200, await repository.getStatus(), headOnly);
        return true;
      }
      if (url.pathname === `${API_ROOT}/sessions`) {
        sendJson(response, 200, await repository.list(parseListQuery(url.searchParams)), headOnly);
        return true;
      }

      const segments = url.pathname.slice(`${API_ROOT}/sessions/`.length).split("/");
      if (
        !url.pathname.startsWith(`${API_ROOT}/sessions/`) ||
        segments.length === 0 ||
        !isOpaqueId(segments[0] ?? "")
      ) {
        return notFound(response, headOnly);
      }
      const id = segments[0]!;
      if (segments.length === 1) {
        const result = await repository.getSession(id);
        if (result === null) return notFound(response, headOnly, "session_not_found");
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (segments.length === 2 && segments[1] === "items") {
        const result = await repository.getItems(id, parseItemQuery(url.searchParams));
        if (result === null) return notFound(response, headOnly, "session_not_found");
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (
        segments.length === 4 &&
        segments[1] === "items" &&
        isItemId(segments[2] ?? "") &&
        segments[3] === "tool"
      ) {
        const result = await repository.getToolDetail(
          id,
          segments[2]!,
          parseToolQuery(url.searchParams),
        );
        if (result === null) return notFound(response, headOnly, "tool_not_found");
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (
        segments.length === 4 &&
        segments[1] === "items" &&
        isItemId(segments[2] ?? "") &&
        segments[3] === "context"
      ) {
        const result = await repository.getInjectedContextDetail(
          id,
          segments[2]!,
          parseInjectedContextQuery(url.searchParams),
        );
        if (result === null) return notFound(response, headOnly, "context_not_found");
        sendJson(response, 200, result, headOnly);
        return true;
      }
      return notFound(response, headOnly);
    } catch (error) {
      if (error instanceof RepositoryQueryError) {
        const status = error.code === "stale_generation" ? 409 : 400;
        sendJson(response, status, { error: { code: error.code, message: error.message } }, headOnly);
        return true;
      }
      sendJson(
        response,
        500,
        { error: { code: "internal_error", message: "The local session reader could not complete the request" } },
        headOnly,
      );
      return true;
    }
  };
}

function parseListQuery(params: URLSearchParams): SessionListQuery {
  const query: SessionListQuery = {};
  const q = optional(params, "q");
  const project = optional(params, "project");
  const from = optional(params, "from");
  const to = optional(params, "to");
  const archived = optional(params, "archived");
  const offset = optional(params, "offset");
  const limit = optional(params, "limit");
  const generation = optional(params, "generation");
  if (q !== undefined) query.q = q;
  if (project !== undefined) query.project = project;
  if (from !== undefined) query.from = from;
  if (to !== undefined) query.to = to;
  if (archived !== undefined) {
    if (archived !== "true" && archived !== "false") invalid("archived must be true or false");
    query.archived = archived === "true";
  }
  if (offset !== undefined) query.offset = integer(offset, "offset");
  if (limit !== undefined) query.limit = integer(limit, "limit");
  if (generation !== undefined) query.generation = integer(generation, "generation");
  return query;
}

function parseItemQuery(params: URLSearchParams): ItemPageQuery {
  const query: ItemPageQuery = {};
  const afterOrdinal = optional(params, "afterOrdinal");
  const limit = optional(params, "limit");
  const view = optional(params, "view");
  const generation = optional(params, "generation");
  if (afterOrdinal !== undefined) query.afterOrdinal = integer(afterOrdinal, "afterOrdinal");
  if (limit !== undefined) query.limit = integer(limit, "limit");
  if (view !== undefined) {
    if (view !== "conversation" && view !== "internal") invalid("view must be conversation or internal");
    query.view = view;
  }
  if (generation !== undefined) query.generation = integer(generation, "generation");
  return query;
}

function parseToolQuery(params: URLSearchParams): ToolDetailQuery {
  const generation = optional(params, "generation");
  if (generation === undefined) invalid("generation is required for tool detail");
  return { generation: integer(generation, "generation") };
}

function parseInjectedContextQuery(params: URLSearchParams): InjectedContextDetailQuery {
  const generation = optional(params, "generation");
  if (generation === undefined) invalid("generation is required for injected context detail");
  return { generation: integer(generation, "generation") };
}

function optional(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) invalid(`${name} must appear once`);
  return values[0];
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) invalid(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) invalid(`${name} is outside the supported range`);
  return result;
}

function invalid(message: string): never {
  throw new RepositoryQueryError("invalid_query", message);
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,100}$/.test(value);
}

function isItemId(value: string): boolean {
  return /^(?:message|tool|context|reasoning|internal)-\d+$/.test(value);
}

function notFound(
  response: ServerResponse,
  headOnly: boolean,
  code = "not_found",
): true {
  sendJson(response, 404, { error: { code, message: "API resource not found" } }, headOnly);
  return true;
}
