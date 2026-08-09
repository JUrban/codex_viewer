import { ApiClientError } from "../api/client";

export function messageFor(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return "The local session reader could not complete the request.";
}

export function isAbort(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null &&
    "name" in reason && reason.name === "AbortError";
}

export function isStaleListCursor(reason: unknown): reason is ApiClientError {
  return reason instanceof ApiClientError && reason.code === "stale_list_cursor";
}

export function isTimelineConflict(reason: unknown): reason is ApiClientError {
  return reason instanceof ApiClientError && reason.code === "timeline_changed";
}
