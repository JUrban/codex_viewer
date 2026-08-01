import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DirectiveDetailQuery,
  ItemPageQuery,
  SessionDetailQuery,
  SessionListQuery,
  SessionReadCursor,
  ToolDetailQuery,
} from "../../shared/api-contract.js";
import {
  RepositoryQueryError,
  type SessionRepository,
} from "../repository/session-repository.js";
import { isSessionRevision } from "../repository/session-revision-registry.js";
import { isTimelinePrefixRevision } from "../repository/session-view-digest.js";
import { isListRevision } from "../repository/list-revision.js";
import { sendJson, type ApiRouter } from "./router.js";
import {
  SessionInteractionError,
  type SessionInteractionService,
} from "../interaction/interaction-service.js";
import {
  MAX_INTERACTION_MESSAGE_BYTES,
  normalizeMessage,
  TmuxInteractionError,
} from "../interaction/tmux-service.js";

const API_ROOT = "/api/v1";
const SESSION_ROOT = `${API_ROOT}/sessions`;

export interface ApiErrorLogger {
  error(
    message: string,
    context: { readonly requestId: string; readonly error: unknown },
  ): void;
}

export interface ApiRouterOptions {
  readonly logger?: ApiErrorLogger;
  readonly requestId?: () => string;
  readonly interaction?: Pick<
    SessionInteractionService,
    "describe" | "sendMessage" | "interrupt" | "escape"
  >;
}

const CONSOLE_ERROR_LOGGER: ApiErrorLogger = {
  error(message, context) {
    console.error(`${message} [requestId=${context.requestId}]`, context.error);
  },
};

export function createApiRouter(
  repository: SessionRepository,
  options: ApiRouterOptions = {},
): ApiRouter {
  const logger = options.logger ?? CONSOLE_ERROR_LOGGER;
  const requestIdFactory = options.requestId ?? randomUUID;
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    const requestId = requestIdFactory();
    const headOnly = request.method === "HEAD";
    const readMethod = request.method === "GET" || headOnly;
    const mutationPath = new RegExp(
      `^${SESSION_ROOT}/[A-Za-z0-9_-]{20,100}/(?:messages|interrupt|keys)$`,
    ).test(url.pathname);
    if (!readMethod && (request.method !== "POST" || !mutationPath)) return false;

    try {
      if (url.pathname === SESSION_ROOT) {
        if (!readMethod) return false;
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
        if (!readMethod) return false;
        const result = await repository.getSession(
          id,
          parseSessionQuery(url.searchParams),
        );
        if (result === null) return notFound(response, headOnly, "session_not_found");
        sendJson(response, 200, {
          ...result,
          interaction: await describeInteraction(options.interaction, id),
        }, headOnly);
        return true;
      }
      if (segments.length === 1 && segments[0] === "messages") {
        if (request.method !== "POST") return false;
        if (options.interaction === undefined) return interactionUnavailable(response);
        const body = await readJsonObject(request);
        if (Object.keys(body).length !== 1 || typeof body.message !== "string") {
          invalidBody("body must contain only a string message field");
        }
        normalizeMessage(body.message);
        await options.interaction.sendMessage(id, body.message);
        return noContent(response);
      }
      if (segments.length === 1 && segments[0] === "interrupt") {
        if (request.method !== "POST") return false;
        if (options.interaction === undefined) return interactionUnavailable(response);
        await requireOptionalEmptyJsonObject(request);
        await options.interaction.interrupt(id);
        return noContent(response);
      }
      if (segments.length === 1 && segments[0] === "keys") {
        if (request.method !== "POST") return false;
        if (options.interaction === undefined) return interactionUnavailable(response);
        const body = await readJsonObject(request);
        if (Object.keys(body).length !== 1 || body.key !== "escape") {
          invalidBody('body must be { "key": "escape" }');
        }
        await options.interaction.escape(id);
        return noContent(response);
      }
      if (segments.length === 1 && segments[0] === "items") {
        if (!readMethod) return false;
        const result = await repository.getItems(id, parseItemQuery(url.searchParams));
        if (result === null) return notFound(response, headOnly, "session_not_found");
        sendJson(response, 200, {
          ...result,
          interaction: await describeInteraction(options.interaction, id),
        }, headOnly);
        return true;
      }
      if (
        segments.length === 3 &&
        segments[0] === "items" &&
        isItemId(itemId) &&
        segments[2] === "tool"
      ) {
        if (!readMethod) return false;
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
        if (!readMethod) return false;
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
        const status = error.code === "stale_list_revision" ||
            error.code === "stale_timeline_prefix"
          ? 409
          : 400;
        sendJson(response, status, { error: { code: error.code, message: error.message } }, headOnly);
        return true;
      }
      if (error instanceof RequestBodyError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message },
        }, headOnly);
        return true;
      }
      if (error instanceof TmuxInteractionError && error.code === "invalid_message") {
        sendJson(response, 400, {
          error: { code: "invalid_message", message: error.message },
        }, headOnly);
        return true;
      }
      if (error instanceof SessionInteractionError) {
        const status = error.code === "session_not_found"
          ? 404
          : error.code === "operation_result_unknown"
          ? 504
          : error.code === "interaction_failed"
          ? 502
          : 409;
        sendJson(response, status, {
          error: { code: error.code, message: error.message },
        }, headOnly);
        return true;
      }
      logger.error("Session API request failed", { requestId, error });
      sendJson(
        response,
        500,
        {
          error: {
            code: "internal_error",
            message: "The local session reader could not complete the request",
            requestId,
          },
        },
        headOnly,
      );
      return true;
    }
  };
}

async function describeInteraction(
  interaction: ApiRouterOptions["interaction"],
  sessionId: string,
) {
  if (interaction === undefined) return { supported: false as const };
  return await interaction.describe(sessionId) ?? { supported: false as const };
}

const MAX_INTERACTION_JSON_BYTES = MAX_INTERACTION_MESSAGE_BYTES * 6 + 1_024;

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: "invalid_json" | "body_too_large",
    message: string,
  ) {
    super(message);
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") invalidBody("Content-Type must be application/json");
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_INTERACTION_JSON_BYTES) bodyTooLarge();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_INTERACTION_JSON_BYTES) bodyTooLarge();
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    invalidBody("Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalidBody("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function requireOptionalEmptyJsonObject(request: IncomingMessage): Promise<void> {
  if (
    request.headers["content-length"] === undefined &&
    request.headers["transfer-encoding"] === undefined
  ) return;
  const body = await readJsonObject(request);
  if (Object.keys(body).length !== 0) invalidBody("body must be an empty JSON object");
}

function invalidBody(message: string): never {
  throw new RequestBodyError(400, "invalid_json", message);
}

function bodyTooLarge(): never {
  throw new RequestBodyError(413, "body_too_large", "Request body is too large");
}

function noContent(response: ServerResponse): true {
  response.statusCode = 204;
  response.end();
  return true;
}

function interactionUnavailable(response: ServerResponse): true {
  sendJson(response, 409, {
    error: {
      code: "interaction_not_supported",
      message: "Interaction is not enabled",
    },
  });
  return true;
}

function parseListQuery(params: URLSearchParams): SessionListQuery {
  const query: SessionListQuery = {};
  const q = optional(params, "q");
  const project = optional(params, "project");
  const from = optional(params, "from");
  const to = optional(params, "to");
  const archiveScope = optional(params, "archiveScope");
  const offset = optional(params, "offset");
  const limit = optional(params, "limit");
  const listRevision = optional(params, "listRevision");
  if (q !== undefined) query.q = q;
  if (project !== undefined) query.project = project;
  if (from !== undefined) query.from = from;
  if (to !== undefined) query.to = to;
  if (archiveScope !== undefined) {
    if (
      archiveScope !== "active" &&
      archiveScope !== "archived" &&
      archiveScope !== "all"
    ) {
      invalid("archiveScope must be active, archived, or all");
    }
    query.archiveScope = archiveScope;
  }
  if (offset !== undefined) query.offset = integer(offset, "offset");
  if (limit !== undefined) query.limit = integer(limit, "limit");
  if (listRevision !== undefined) {
    if (!isListRevision(listRevision)) invalid("listRevision is invalid");
    query.listRevision = listRevision;
  }
  return query;
}

function parseSessionQuery(params: URLSearchParams): SessionDetailQuery {
  const cursor = optionalReadCursor(params, "session");
  return cursor === undefined ? {} : { cursor };
}

function parseItemQuery(params: URLSearchParams): ItemPageQuery {
  const query: ItemPageQuery = {
    cursor: requiredReadCursor(params, "items"),
  };
  const limit = optional(params, "limit");
  if (limit !== undefined) query.limit = integer(limit, "limit");
  return query;
}

function parseToolQuery(params: URLSearchParams): ToolDetailQuery {
  return { cursor: requiredReadCursor(params, "tool detail") };
}

function parseDirectiveQuery(params: URLSearchParams): DirectiveDetailQuery {
  return { cursor: requiredReadCursor(params, "directive detail") };
}

function requiredReadCursor(
  params: URLSearchParams,
  resource: string,
): SessionReadCursor {
  const cursor = optionalReadCursor(params, resource);
  if (cursor === undefined) invalid(`read cursor is required for ${resource}`);
  return cursor;
}

function optionalReadCursor(
  params: URLSearchParams,
  resource: string,
): SessionReadCursor | undefined {
  const revision = optional(params, "sessionRevision");
  const throughOrdinal = optional(params, "throughOrdinal");
  const prefix = optional(params, "timelinePrefixRevision");
  const provided = [revision, throughOrdinal, prefix].filter(
    (value) => value !== undefined,
  ).length;
  if (provided === 0) return undefined;
  if (provided !== 3) {
    invalid(`sessionRevision, throughOrdinal, and timelinePrefixRevision must appear together for ${resource}`);
  }
  if (!isSessionRevision(revision!)) invalid("sessionRevision is invalid");
  if (!isTimelinePrefixRevision(prefix!)) {
    invalid("timelinePrefixRevision is invalid");
  }
  return {
    sessionRevision: revision!,
    throughOrdinal: integer(throughOrdinal!, "throughOrdinal"),
    timelinePrefixRevision: prefix,
  };
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
