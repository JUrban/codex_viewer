import type { IncomingMessage, ServerResponse } from "node:http";
import {
  INTERACTION_KEYS,
  MAX_INTERACTION_KEY_SEQUENCE_LENGTH,
  MAX_INTERACTION_MESSAGE_BYTES,
  type InteractionKey,
} from "../../shared/api-contract.js";
import {
  SessionInteractionError,
  type SessionInteractionService,
} from "../interaction/interaction-service.js";
import {
  normalizeMessage,
  TmuxInteractionError,
} from "../interaction/tmux-service.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { sendJson } from "./router.js";

const INTERACTION_PATH = /^\/api\/v1\/sessions\/[A-Za-z0-9_-]{20,100}\/(?:terminal-preview|messages|keys)$/;
const SESSION_ROOT = "/api/v1/sessions";
const MAX_INTERACTION_JSON_BYTES = MAX_INTERACTION_MESSAGE_BYTES * 6 + 1_024;
const INTERACTION_KEY_SET = new Set<string>(INTERACTION_KEYS);

type InteractionRoutesService = Pick<
  SessionInteractionService,
  "preview" | "sendMessage" | "sendKeys"
>;

export function createSessionInteractionRoutes(
  interaction?: InteractionRoutesService,
): ApiRouteHandler {
  return {
    matches: (url) => INTERACTION_PATH.test(url.pathname),
    async handle(request, response, url) {
      const [id = "", operation = ""] = url.pathname
        .slice(SESSION_ROOT.length + 1)
        .split("/");
      if (operation === "terminal-preview") {
        const headOnly = request.method === "HEAD";
        if (request.method !== "GET" && !headOnly) return false;
        if ([...url.searchParams].length > 0) {
          invalidQuery("terminal preview does not accept query parameters");
        }
        if (interaction === undefined) return interactionUnavailable(response);
        sendJson(response, 200, await interaction.preview(id), headOnly);
        return true;
      }
      if (request.method !== "POST") return false;
      if (interaction === undefined) return interactionUnavailable(response);
      if (operation === "messages") {
        const body = await readJsonObject(request);
        if (Object.keys(body).length !== 1 || typeof body.message !== "string") {
          invalidBody("body must contain only a string message field");
        }
        normalizeMessage(body.message);
        await interaction.sendMessage(id, body.message);
        return noContent(response);
      }
      if (operation === "keys") {
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
        await interaction.sendKeys(id, body.keys);
        return noContent(response);
      }
      return false;
    },
    mapError(error, request, response) {
      const headOnly = request.method === "HEAD";
      if (error instanceof RequestBodyError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message },
        }, headOnly);
        return true;
      }
      if (error instanceof InteractionRouteQueryError) {
        sendJson(response, 400, {
          error: { code: "invalid_query", message: error.message },
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
      return false;
    },
  };
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: "invalid_json" | "body_too_large",
    message: string,
  ) {
    super(message);
  }
}

class InteractionRouteQueryError extends Error {}

async function readJsonObject(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    invalidBody("Content-Type must be application/json");
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_INTERACTION_JSON_BYTES) {
    bodyTooLarge();
  }
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

function invalidQuery(message: string): never {
  throw new InteractionRouteQueryError(message);
}

function bodyTooLarge(): never {
  throw new RequestBodyError(
    413,
    "body_too_large",
    "Request body is too large",
  );
}

function isInteractionKey(value: unknown): value is InteractionKey {
  return typeof value === "string" && INTERACTION_KEY_SET.has(value);
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
