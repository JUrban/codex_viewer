import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  SessionListQuery,
  SessionListResponse,
} from "../../shared/api-contract";
import { api, ApiClientError } from "../api/client";
import type { BrowserFilters } from "./use-browser-location";

const LIST_PAGE_SIZE = 200;

type ListMode = "initial" | "ready" | "paging" | "refreshing";

interface ListState {
  mode: ListMode;
  data: SessionListResponse | null;
  error: string | null;
  refreshError: string | null;
  refreshMessage: string | null;
}

type ListAction =
  | { type: "load-start" }
  | { type: "load-success"; data: SessionListResponse }
  | { type: "load-failure"; error: string }
  | { type: "page-start" }
  | { type: "page-success"; data: SessionListResponse }
  | { type: "page-failure"; error: string }
  | { type: "refresh-start" }
  | { type: "refresh-success"; data: SessionListResponse }
  | { type: "refresh-failure"; error: string }
  | { type: "refresh-message"; message: string }
  | { type: "clear-error" };

const initialState: ListState = {
  mode: "initial",
  data: null,
  error: null,
  refreshError: null,
  refreshMessage: null,
};

export function useSessionList(filters: BrowserFilters) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q);
  const loadAbort = useRef<AbortController | null>(null);
  const pageAbort = useRef<AbortController | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const filtersRef = useRef(filters);
  const queryRef = useRef(debouncedQuery);
  filtersRef.current = filters;
  queryRef.current = debouncedQuery;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(filters.q), 250);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  useEffect(() => {
    loadAbort.current?.abort();
    pageAbort.current?.abort();
    refreshAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    const request = ++sequence.current;
    dispatch({ type: "load-start" });
    void api.sessions(listQuery(filters, debouncedQuery), controller.signal)
      .then((data) => {
        if (request === sequence.current) dispatch({ type: "load-success", data });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && request === sequence.current) {
          dispatch({ type: "load-failure", error: messageFor(reason) });
        }
      })
      .finally(() => {
        if (loadAbort.current === controller) loadAbort.current = null;
      });
    return () => controller.abort();
  }, [debouncedQuery, filters.archiveScope, filters.from, filters.project, filters.to]);

  const loadMoreSessions = useCallback(async () => {
    const current = state.data;
    if (!current?.hasMore || current.nextOffset === null) return;
    pageAbort.current?.abort();
    const controller = new AbortController();
    pageAbort.current = controller;
    const request = sequence.current;
    dispatch({ type: "page-start" });
    try {
      let next: SessionListResponse;
      try {
        next = await api.sessions({
          ...listQuery(filtersRef.current, queryRef.current),
          offset: current.nextOffset,
          generation: current.generation,
        }, controller.signal);
      } catch (reason) {
        if (!isStaleGeneration(reason)) throw reason;
        next = await api.sessions(
          listQuery(filtersRef.current, queryRef.current),
          controller.signal,
        );
      }
      if (!controller.signal.aborted && request === sequence.current) {
        dispatch({ type: "page-success", data: mergePage(current, next) });
      }
    } catch (reason) {
      if (!controller.signal.aborted && request === sequence.current) {
        dispatch({ type: "page-failure", error: messageFor(reason) });
      }
    } finally {
      if (pageAbort.current === controller) pageAbort.current = null;
    }
  }, [state.data]);

  const refresh = useCallback(async (): Promise<SessionListResponse | null> => {
    if (refreshAbort.current !== null) return null;
    loadAbort.current?.abort();
    pageAbort.current?.abort();
    const controller = new AbortController();
    refreshAbort.current = controller;
    const request = ++sequence.current;
    dispatch({ type: "refresh-start" });
    try {
      const data = await api.sessions(
        listQuery(filtersRef.current, queryRef.current),
        controller.signal,
      );
      if (controller.signal.aborted || request !== sequence.current) return null;
      dispatch({ type: "refresh-success", data });
      return data;
    } catch (reason) {
      if (!controller.signal.aborted && request === sequence.current) {
        dispatch({ type: "refresh-failure", error: messageFor(reason) });
      }
      return null;
    } finally {
      if (refreshAbort.current === controller) refreshAbort.current = null;
    }
  }, []);

  useEffect(() => () => {
    loadAbort.current?.abort();
    pageAbort.current?.abort();
    refreshAbort.current?.abort();
  }, []);

  return {
    list: state.data,
    listLoading: state.mode === "initial" || state.mode === "paging",
    refreshing: state.mode === "refreshing",
    listError: state.error,
    refreshError: state.refreshError,
    refreshMessage: state.refreshMessage,
    loadMoreSessions,
    refresh,
    setRefreshMessage: (message: string) => dispatch({ type: "refresh-message", message }),
    clearListError: () => dispatch({ type: "clear-error" }),
  };
}

function reducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case "load-start":
      return {
        ...state,
        mode: state.data === null ? "initial" : "ready",
        error: null,
        refreshError: null,
        refreshMessage: null,
      };
    case "load-success":
      return { ...state, mode: "ready", data: action.data, error: null };
    case "load-failure":
      return { ...state, mode: "ready", error: action.error };
    case "page-start":
      return { ...state, mode: "paging", error: null };
    case "page-success":
      return { ...state, mode: "ready", data: action.data, error: null };
    case "page-failure":
      return { ...state, mode: "ready", error: action.error };
    case "refresh-start":
      return {
        ...state,
        mode: "refreshing",
        refreshError: null,
        refreshMessage: null,
      };
    case "refresh-success":
      return { ...state, mode: "ready", data: action.data, error: null };
    case "refresh-failure":
      return { ...state, mode: "ready", refreshError: action.error };
    case "refresh-message":
      return { ...state, refreshMessage: action.message };
    case "clear-error":
      return { ...state, error: null };
  }
}

function listQuery(filters: BrowserFilters, q: string): SessionListQuery {
  return {
    q: q || undefined,
    project: filters.project || undefined,
    from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : undefined,
    archiveScope: filters.archiveScope,
    limit: LIST_PAGE_SIZE,
  };
}

function mergePage(
  current: SessionListResponse,
  next: SessionListResponse,
): SessionListResponse {
  if (current.generation !== next.generation) return next;
  const seen = new Set(current.sessions.map((entry) => entry.session.id));
  return {
    ...next,
    sessions: [
      ...current.sessions,
      ...next.sessions.filter((entry) => !seen.has(entry.session.id)),
    ],
  };
}

function messageFor(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return "The local session reader could not complete the request.";
}

function isStaleGeneration(reason: unknown): reason is ApiClientError {
  return reason instanceof ApiClientError && reason.code === "stale_generation";
}
