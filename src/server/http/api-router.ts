import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  INTERACTION_KEYS,
  MAX_INTERACTION_KEY_SEQUENCE_LENGTH,
  MAX_INTERACTION_MESSAGE_BYTES,
  type InteractionKey,
} from "../../shared/api-contract.js";
import type {
  DirectiveDetailQuery,
  ItemPageQuery,
  SessionLiveQuery,
  SessionListQuery,
  TimelineCursor,
  ToolDetailQuery,
} from "../../shared/api-contract.js";
import {
  RepositoryQueryError,
  type SessionRepository,
} from "../repository/session-repository.js";
import { sendJson, type ApiRouter } from "./router.js";
import {
  SessionInteractionError,
  type SessionInteractionService,
} from "../interaction/interaction-service.js";
import {
  normalizeMessage,
  TmuxInteractionError,
} from "../interaction/tmux-service.js";
import {
  SessionLiveError,
  SessionLiveService,
} from "../live/session-live-service.js";
import { withLiveRevision } from "../live/live-revision.js";

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
    "describe" | "sendMessage" | "sendKeys" | "preview"
  > & Partial<Pick<SessionInteractionService, "describeSnapshot">>;
  readonly live?: SessionLiveService;
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
  const live = options.live ?? new SessionLiveService(repository, {
    interaction: options.interaction?.describeSnapshot === undefined
      ? undefined
      : { describeSnapshot: options.interaction.describeSnapshot.bind(options.interaction) },
  });
  const router: ApiRouter = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    const requestId = requestIdFactory();
    const headOnly = request.method === "HEAD";
    const readMethod = request.method === "GET" || headOnly;
    const mutationPath = new RegExp(
      `^${SESSION_ROOT}/[A-Za-z0-9_-]{20,100}/(?:messages|keys)$`,
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
        if ([...url.searchParams].length > 0) invalid("session metadata does not accept query parameters");
        const result = await repository.getSession(id);
        if (result === null) return notFound(response, headOnly, "session_not_found");
        const interaction = await describeInteraction(options.interaction, id);
        sendJson(response, 200, withLiveRevision({
          ...result,
          interaction,
        }, live.revision.bind(live)), headOnly);
        return true;
      }
      if (segments.length === 1 && segments[0] === "live") {
        if (!readMethod) return false;
        response.setHeader("Cache-Control", "no-store");
        const abort = new AbortController();
        const onDisconnect = () => {
          if (!response.writableEnded) abort.abort();
        };
        request.once("aborted", onDisconnect);
        response.once("close", onDisconnect);
        try {
          const result = await live.wait(id, parseLiveQuery(url.searchParams), abort.signal);
          if (abort.signal.aborted || response.destroyed) return true;
          if (result === null) return noContent(response);
          sendJson(response, 200, result, headOnly);
          return true;
        } finally {
          request.removeListener("aborted", onDisconnect);
          response.removeListener("close", onDisconnect);
        }
      }
      if (segments.length === 1 && segments[0] === "terminal-preview") {
        if (!readMethod) return false;
        if ([...url.searchParams].length > 0) {
          invalid("terminal preview does not accept query parameters");
        }
        if (options.interaction === undefined) return interactionUnavailable(response);
        sendJson(response, 200, await options.interaction.preview(id), headOnly);
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
      if (segments.length === 1 && segments[0] === "keys") {
        if (request.method !== "POST") return false;
        if (options.interaction === undefined) return interactionUnavailable(response);
        const body = await readJsonObject(request);
        if (Object.keys(body).length !== 1 || !Array.isArray(body.keys)) {
          invalidBody("body must contain only a keys array");
        }
        if (
          body.keys.length === 0 ||
          body.keys.length > MAX_INTERACTION_KEY_SEQUENCE_LENGTH ||
          !body.keys.every(isInteractionKey)
        ) {
          invalidBody(
            `keys must contain 1-${MAX_INTERACTION_KEY_SEQUENCE_LENGTH} supported interaction keys`,
          );
        }
        await options.interaction.sendKeys(id, body.keys);
        return noContent(response);
      }
      if (segments.length === 1 && segments[0] === "items") {
        if (!readMethod) return false;
        const result = await repository.getItems(id, parseItemQuery(url.searchParams));
        if (result === null) return notFound(response, headOnly, "session_not_found");
        const interaction = await describeInteraction(options.interaction, id);
        sendJson(response, 200, withLiveRevision({
          ...result,
          interaction,
        }, live.revision.bind(live)), headOnly);
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
        const status = error.code === "stale_list_cursor" ||
            error.code === "timeline_changed"
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
      if (error instanceof SessionLiveError) {
        const status = error.code === "session_not_found" ? 404 : 429;
        if (status === 429) response.setHeader("Retry-After", "2");
        sendJson(response, status, {
          error: { code: error.code, message: error.message },
        }, headOnly);
        return true;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        if (request.destroyed || response.destroyed) return true;
        return noContent(response);
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
  router.close = () => live.close();
  return router;
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

function invalidBody(message: string): never {
  throw new RequestBodyError(400, "invalid_json", message);
}

const INTERACTION_KEY_SET = new Set<string>(INTERACTION_KEYS);

function isInteractionKey(value: unknown): value is InteractionKey {
  return typeof value === "string" && INTERACTION_KEY_SET.has(value);
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
  only(params, ["project", "from", "to", "archiveScope", "limit", "cursor", "fresh"]);
  const query: SessionListQuery = {};
  const project = optional(params, "project");
  const from = optional(params, "from");
  const to = optional(params, "to");
  const archiveScope = optional(params, "archiveScope");
  const limit = optional(params, "limit");
  const cursor = optional(params, "cursor");
  const fresh = optional(params, "fresh");
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
  if (limit !== undefined) query.limit = integer(limit, "limit");
  if (cursor !== undefined) query.cursor = cursor as import("../../shared/api-contract.js").ListCursor;
  if (fresh !== undefined) {
    if (fresh !== "true") invalid("fresh must be true when provided");
    query.fresh = true;
  }
  if (query.fresh && query.cursor !== undefined) invalid("fresh cannot be used with cursor");
  return query;
}

function parseItemQuery(params: URLSearchParams): ItemPageQuery {
  only(params, ["limit", "cursor"]);
  const query: ItemPageQuery = {};
  const cursor = optional(params, "cursor");
  if (cursor !== undefined) query.cursor = cursor as TimelineCursor;
  const limit = optional(params, "limit");
  if (limit !== undefined) query.limit = integer(limit, "limit");
  return query;
}

function parseLiveQuery(params: URLSearchParams): SessionLiveQuery {
  only(params, ["cursor", "after"]);
  const cursor = optional(params, "cursor");
  const after = optional(params, "after");
  if (cursor === undefined) invalid("cursor is required for Live updates");
  if (after === undefined) invalid("after is required for Live updates");
  if (!/^[A-Za-z0-9_-]{43}$/.test(after)) invalid("after is malformed");
  return {
    cursor: cursor as TimelineCursor,
    after: after as import("../../shared/api-contract.js").LiveRevision,
  };
}

function parseToolQuery(params: URLSearchParams): ToolDetailQuery {
  only(params, ["cursor"]);
  return { cursor: requiredCursor(params, "tool detail") };
}

function parseDirectiveQuery(params: URLSearchParams): DirectiveDetailQuery {
  only(params, ["cursor"]);
  return { cursor: requiredCursor(params, "directive detail") };
}

function requiredCursor(
  params: URLSearchParams,
  resource: string,
): TimelineCursor {
  const cursor = optional(params, "cursor");
  if (cursor === undefined) invalid(`cursor is required for ${resource}`);
  return cursor as TimelineCursor;
}

function optional(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) invalid(`${name} must appear once`);
  return values[0];
}

function only(params: URLSearchParams, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const name of params.keys()) {
    if (!accepted.has(name)) invalid(`${name} is not supported`);
  }
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
