import { randomUUID } from "node:crypto";
import type { SessionReader } from "../application/session-reader.js";
import type { SessionInteractionService } from "../interaction/interaction-service.js";
import type { SessionLiveService } from "../live/session-live-service.js";
import { sendJson, type ApiRouter } from "./router.js";
import { createSessionInteractionRoutes } from "./session-interaction-routes.js";
import { createSessionLiveRoutes } from "./session-live-routes.js";
import { createSessionReadRoutes } from "./session-read-routes.js";

const SESSION_ROOT = "/api/v1/sessions";

export interface ApiErrorLogger {
  error(
    message: string,
    context: { readonly requestId: string; readonly error: unknown },
  ): void;
}

type InteractionApi = Pick<
  SessionInteractionService,
  "describe" | "sendMessage" | "sendKeys" | "preview"
>;

export interface ApiRouterDependencies {
  readonly sessions: SessionReader;
  readonly live: SessionLiveService;
  readonly interaction?: InteractionApi;
}

export interface ApiRouterOptions {
  readonly logger?: ApiErrorLogger;
  readonly requestId?: () => string;
}

const CONSOLE_ERROR_LOGGER: ApiErrorLogger = {
  error(message, context) {
    console.error(`${message} [requestId=${context.requestId}]`, context.error);
  },
};

export function createApiRouter(
  dependencies: ApiRouterDependencies,
  options: ApiRouterOptions = {},
): ApiRouter {
  const logger = options.logger ?? CONSOLE_ERROR_LOGGER;
  const requestIdFactory = options.requestId ?? randomUUID;
  const handlers = [
    createSessionLiveRoutes(dependencies.live),
    createSessionInteractionRoutes(dependencies.interaction),
    createSessionReadRoutes(dependencies),
  ];
  const router: ApiRouter = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    const headOnly = request.method === "HEAD";
    const readMethod = request.method === "GET" || headOnly;
    const mutationPath = new RegExp(
      `^${SESSION_ROOT}/[A-Za-z0-9_-]{20,100}/(?:messages|keys)$`,
    ).test(url.pathname);
    if (!readMethod && (request.method !== "POST" || !mutationPath)) {
      return false;
    }

    const handler = handlers.find((candidate) => candidate.matches(url))!;
    const requestId = requestIdFactory();
    try {
      return await handler.handle(request, response, url);
    } catch (error) {
      if (handler.mapError(error, request, response)) return true;
      logger.error("Session API request failed", { requestId, error });
      sendJson(response, 500, {
        error: {
          code: "internal_error",
          message: "The local session reader could not complete the request",
          requestId,
        },
      }, headOnly);
      return true;
    }
  };
  router.close = () => dependencies.live.close();
  return router;
}
