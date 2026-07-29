import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DirectiveDetailQuery,
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
const SESSION_ROOT = `${API_ROOT}/sessions`;

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
      if (url.pathname === SESSION_ROOT) {
        sendJson(response, 200, await repository.list(parseListQuery(url.searchParams)), headOnly);
        return true;
      }

      if (!url.pathname.startsWith(`${SESSION_ROOT}/`)) {
        return notFound(response, headOnly);
      }
      const [id = "", ...segments] = url.pathname.slice(SESSION_ROOT.length + 1).split("/");
      if (!isOpaqueId(id)) return notFound(response, headOnly);

      const itemId = segments[1] ?? "";
      if (segments.length === 0) {
        const result = await repository.getSession(id);
        if (result === null) return notFound(response, headOnly, "session_not_found");
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (segments.length === 1 && segments[0] === "items") {
        const result = await repository.getItems(id, parseItemQuery(url.searchParams));
        if (result === null) return notFound(response, headOnly, "session_not_found");
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (
        segments.length === 3 &&
        segments[0] === "items" &&
        isItemId(itemId) &&
        segments[2] === "tool"
      ) {
        const result = await repository.getToolDetail(
          id,
          itemId,
          parseToolQuery(url.searchParams),
        );
        if (result === null) return notFound(response, headOnly, "tool_not_found");
        sendJson(response, 200, result, headOnly);
        return true;
      }
      if (
        segments.length === 3 &&
        segments[0] === "items" &&
        isItemId(itemId) &&
        segments[2] === "directive"
      ) {
        const result = await repository.getDirectiveDetail(
          id,
          itemId,
          parseDirectiveQuery(url.searchParams),
        );
        if (result === null) return notFound(response, headOnly, "directive_not_found");
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
  const generation = optional(params, "generation");
  if (afterOrdinal !== undefined) query.afterOrdinal = integer(afterOrdinal, "afterOrdinal");
  if (limit !== undefined) query.limit = integer(limit, "limit");
  if (generation !== undefined) query.generation = integer(generation, "generation");
  return query;
}

function parseToolQuery(params: URLSearchParams): ToolDetailQuery {
  return { generation: requiredGeneration(params, "tool detail") };
}

function parseDirectiveQuery(params: URLSearchParams): DirectiveDetailQuery {
  return { generation: requiredGeneration(params, "directive detail") };
}

function requiredGeneration(params: URLSearchParams, resource: string): number {
  const generation = optional(params, "generation");
  if (generation === undefined) invalid(`generation is required for ${resource}`);
  return integer(generation, "generation");
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
  return /^(?:message|directive|tool|token|internal)-\d+$/.test(value);
}

function notFound(
  response: ServerResponse,
  headOnly: boolean,
  code = "not_found",
): true {
  sendJson(response, 404, { error: { code, message: "API resource not found" } }, headOnly);
  return true;
}
