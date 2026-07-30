import { ApiClientError } from "../api/client";

export function messageFor(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return "The local session reader could not complete the request.";
}

export function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

export function isStaleCatalogGeneration(reason: unknown): reason is ApiClientError {
  return reason instanceof ApiClientError && reason.code === "stale_catalog_generation";
}

export function isStaleSessionRevision(reason: unknown): reason is ApiClientError {
  return reason instanceof ApiClientError && reason.code === "stale_session_revision";
}
