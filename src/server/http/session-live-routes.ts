import type { ServerResponse } from "node:http";
import type {
  LiveRevision,
  SessionLiveQuery,
  TimelineCursor,
} from "../../shared/api-contract.js";
import {
  SessionLiveError,
  type SessionLiveService,
} from "../live/session-live-service.js";
import { RepositoryQueryError } from "../repository/session-queries.js";
import type { ApiRouteHandler } from "./api-route-handler.js";
import { sendJson } from "./router.js";

const LIVE_PATH = /^\/api\/v1\/sessions\/[A-Za-z0-9_-]{20,100}\/live$/;
const SESSION_ROOT = "/api/v1/sessions";

export function createSessionLiveRoutes(live: SessionLiveService): ApiRouteHandler {
  return {
    matches: (url) => LIVE_PATH.test(url.pathname),
    async handle(request, response, url) {
      const headOnly = request.method === "HEAD";
      if (request.method !== "GET" && !headOnly) return false;
      const id = url.pathname.slice(SESSION_ROOT.length + 1).split("/", 1)[0]!;
      response.setHeader("Cache-Control", "no-store");
      const abort = new AbortController();
      const onDisconnect = () => {
        if (!response.writableEnded) abort.abort();
      };
      request.once("aborted", onDisconnect);
      response.once("close", onDisconnect);
      try {
        const result = await live.wait(
          id,
          parseLiveQuery(url.searchParams),
          abort.signal,
        );
        if (abort.signal.aborted || response.destroyed) return true;
        if (result === null) return noContent(response);
        sendJson(response, 200, result, headOnly);
        return true;
      } finally {
        request.removeListener("aborted", onDisconnect);
        response.removeListener("close", onDisconnect);
      }
    },
    mapError(error, request, response) {
      const headOnly = request.method === "HEAD";
      if (error instanceof RepositoryQueryError) {
        const status = error.code === "timeline_changed" ? 409 : 400;
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
      return false;
    },
  };
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
    after: after as LiveRevision,
  };
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

function invalid(message: string): never {
  throw new RepositoryQueryError("invalid_query", message);
}

function noContent(response: ServerResponse): true {
  response.statusCode = 204;
  response.end();
  return true;
}
