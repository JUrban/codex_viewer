import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  SessionListQuery,
  SessionListResponse,
} from "../../shared/api-contract";
import { api } from "../api/client";
import { isAbort, isStaleListCursor, messageFor } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  waitForRetry,
} from "./retry-policy";
import type { SessionCatalogFilters } from "./use-session-filters";

const LIST_PAGE_SIZE = 300;

export type CatalogOperation = "query" | "page" | "refresh" | null;

interface ListState {
  key: string | null;
  operation: CatalogOperation;
  data: SessionListResponse | null;
  error: string | null;
}

type ListAction =
  | { type: "query-start"; key: string }
  | { type: "query-success"; key: string; data: SessionListResponse }
  | { type: "query-failure"; error: string }
  | { type: "page-start" }
  | { type: "page-retry"; error: string }
  | { type: "page-success"; data: SessionListResponse }
  | { type: "page-failure"; error: string }
  | { type: "refresh-start" }
  | { type: "refresh-success"; data: SessionListResponse }
  | { type: "refresh-failure"; error: string }
  | { type: "clear-error" };

interface ActiveRequest {
  operation: Exclude<CatalogOperation, null>;
  controller: AbortController;
  key: string;
}

const initialState: ListState = {
  key: null,
  operation: null,
  data: null,
  error: null,
};

export function useSessionList(filters: SessionCatalogFilters) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const active = useRef<ActiveRequest | null>(null);
  const filtersRef = useRef(filters);
  const key = filtersKey(filters);
  const keyRef = useRef(key);
  const stateRef = useRef(state);
  filtersRef.current = filters;
  keyRef.current = key;
  stateRef.current = state;

  const isCurrent = useCallback((request: ActiveRequest) => (
    active.current === request &&
    !request.controller.signal.aborted &&
    keyRef.current === request.key
  ), []);

  useEffect(() => {
    active.current?.controller.abort();
    const request: ActiveRequest = {
      operation: "query",
      controller: new AbortController(),
      key,
    };
    active.current = request;
    dispatch({ type: "query-start", key });
    void api.sessions(listQuery(filters), request.controller.signal)
      .then((data) => {
        if (isCurrent(request)) dispatch({ type: "query-success", key, data });
      })
      .catch((reason: unknown) => {
        if (isCurrent(request)) {
          dispatch({ type: "query-failure", error: messageFor(reason) });
        }
      })
      .finally(() => {
        if (active.current === request) active.current = null;
      });
    return () => request.controller.abort();
  }, [key, isCurrent]);

  const loadMoreSessions = useCallback(async () => {
    if (active.current !== null) return;
    const current = stateRef.current.data;
    if (current?.nextCursor === null || current === null) return;
    const request: ActiveRequest = {
      operation: "page",
      controller: new AbortController(),
      key: keyRef.current,
    };
    active.current = request;
    dispatch({ type: "page-start" });
    let retryMs = INITIAL_RETRY_MS;
    try {
      while (isCurrent(request)) {
        try {
          let next: SessionListResponse;
          let restarted = false;
          try {
            next = await api.sessions({
              ...listQuery(filtersRef.current),
              cursor: current.nextCursor,
            }, request.controller.signal);
          } catch (reason) {
            if (!isCurrent(request) || !isStaleListCursor(reason)) throw reason;
            restarted = true;
            next = await api.sessions(
              listQuery(filtersRef.current),
              request.controller.signal,
            );
          }
          if (isCurrent(request)) {
            dispatch({ type: "page-success", data: restarted ? next : mergePage(current, next) });
          }
          return;
        } catch (reason) {
          if (!isCurrent(request) || isAbort(reason)) return;
          if (!isRetryableRequestError(reason)) throw reason;
          dispatch({ type: "page-retry", error: messageFor(reason) });
          await waitForRetry(retryMs, request.controller.signal);
          retryMs = nextRetryMs(retryMs);
        }
      }
    } catch (reason) {
      if (isCurrent(request)) {
        dispatch({ type: "page-failure", error: messageFor(reason) });
      }
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [isCurrent]);

  const refresh = useCallback(async (): Promise<SessionListResponse | null> => {
    if (active.current !== null) return null;
    const request: ActiveRequest = {
      operation: "refresh",
      controller: new AbortController(),
      key: keyRef.current,
    };
    active.current = request;
    dispatch({ type: "refresh-start" });
    try {
      const data = await api.sessions(
        { ...listQuery(filtersRef.current), fresh: true },
        request.controller.signal,
      );
      if (!isCurrent(request)) return null;
      dispatch({ type: "refresh-success", data });
      return data;
    } catch (reason) {
      if (isCurrent(request)) {
        dispatch({ type: "refresh-failure", error: messageFor(reason) });
      }
      return null;
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [isCurrent]);

  useEffect(() => () => {
    active.current?.controller.abort();
    active.current = null;
  }, []);

  const changingQuery = state.key !== key;
  const operation = changingQuery ? "query" : state.operation;
  return {
    list: changingQuery ? null : state.data,
    operation,
    listLoading: operation === "query" || operation === "page",
    refreshing: operation === "refresh",
    listError: state.error,
    loadMoreSessions,
    refresh,
    clearListError: () => dispatch({ type: "clear-error" }),
  };
}

function reducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case "query-start":
      return {
        ...state,
        key: action.key,
        operation: "query",
        data: null,
        error: null,
      };
    case "query-success":
      return {
        ...state,
        key: action.key,
        operation: null,
        data: action.data,
        error: null,
      };
    case "query-failure":
      return { ...state, operation: null, error: action.error };
    case "page-start":
      return { ...state, operation: "page", error: null };
    case "page-retry":
      return { ...state, operation: "page", error: action.error };
    case "page-success":
      return { ...state, operation: null, data: action.data, error: null };
    case "page-failure":
      return { ...state, operation: null, error: action.error };
    case "refresh-start":
      return {
        ...state,
        operation: "refresh",
        error: null,
      };
    case "refresh-success":
      return { ...state, operation: null, data: action.data, error: null };
    case "refresh-failure":
      return { ...state, operation: null, error: action.error };
    case "clear-error":
      return { ...state, error: null };
  }
}

function listQuery(filters: SessionCatalogFilters): SessionListQuery {
  return {
    project: filters.project || undefined,
    from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : undefined,
    archiveScope: filters.archiveScope,
    limit: LIST_PAGE_SIZE,
  };
}

function filtersKey(filters: SessionCatalogFilters): string {
  return JSON.stringify([
    filters.project,
    filters.from,
    filters.to,
    filters.archiveScope,
  ]);
}

function mergePage(
  current: SessionListResponse,
  next: SessionListResponse,
): SessionListResponse {
  const seen = new Set(current.sessions.map((session) => session.id));
  return {
    ...next,
    sessions: [
      ...current.sessions,
      ...next.sessions.filter((session) => !seen.has(session.id)),
    ],
  };
}
