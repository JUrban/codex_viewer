import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  ItemPageResponse,
  SessionDetailResponse,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";
import { isAbort, isStaleSessionRevision, messageFor } from "./request-errors";
import { useSessionPolling } from "./use-session-polling";

const TIMELINE_PAGE_SIZE = 512;
const DEFAULT_REFRESH_INTERVAL_SECONDS = 5;
const MIN_REFRESH_INTERVAL_SECONDS = 1;
const MAX_REFRESH_INTERVAL_SECONDS = 3_600;
const REFRESH_INTERVAL_STORAGE_KEY =
  "codex-sessions-reader.refresh-interval-seconds.v1";

export type ReaderOperation = "open" | "page" | "refresh" | null;

interface ReaderState {
  operation: ReaderOperation;
  detail: SessionDetailResponse | null;
  page: ItemPageResponse | null;
  items: TimelineItem[];
  error: string | null;
}

type ReaderAction =
  | { type: "clear" }
  | { type: "reset-timeline" }
  | {
    type: "open-start";
    operation: Exclude<ReaderOperation, null | "page">;
    preserve: boolean;
  }
  | {
    type: "load-success";
    detail: SessionDetailResponse;
    page: ItemPageResponse;
    preserveSameRevision: boolean;
  }
  | { type: "load-failure"; error: string }
  | { type: "page-start" }
  | { type: "page-success"; page: ItemPageResponse }
  | { type: "page-failure"; error: string }
  | { type: "clear-error" };

interface ActiveRequest {
  operation: Exclude<ReaderOperation, null>;
  controller: AbortController;
  id: string;
}

const initialState: ReaderState = {
  operation: null,
  detail: null,
  page: null,
  items: [],
  error: null,
};

type SessionLoadResult = "loaded" | "missing" | "failed";

export function useSessionReader(
  selectedId: string | null,
  clearMissingSession: () => void,
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [refreshIntervalSeconds, setRefreshIntervalSecondsState] = useState(
    readRefreshIntervalSeconds,
  );
  const active = useRef<ActiveRequest | null>(null);
  const selectedIdRef = useRef(selectedId);
  const stateRef = useRef(state);
  selectedIdRef.current = selectedId;
  stateRef.current = state;

  const abortActive = useCallback(() => {
    active.current?.controller.abort();
    active.current = null;
  }, []);

  const isCurrent = useCallback((request: ActiveRequest) => (
    active.current === request &&
    !request.controller.signal.aborted &&
    selectedIdRef.current === request.id
  ), []);

  const loadSession = useCallback(async (
    id: string,
    quiet = false,
  ): Promise<SessionLoadResult> => {
    abortActive();
    const operation: "open" | "refresh" = quiet ? "refresh" : "open";
    const request: ActiveRequest = {
      operation,
      controller: new AbortController(),
      id,
    };
    active.current = request;
    dispatch({
      type: "open-start",
      operation,
      preserve: quiet || stateRef.current.detail?.session.id === id,
    });
    try {
      let detail = await api.session(id, request.controller.signal);
      if (!isCurrent(request)) return "failed";
      let page: ItemPageResponse;
      try {
        page = await api.items(id, {
          sessionRevision: detail.sessionRevision,
          limit: TIMELINE_PAGE_SIZE,
        }, request.controller.signal);
      } catch (reason) {
        if (!isCurrent(request) || !isStaleSessionRevision(reason)) throw reason;
        detail = await api.session(id, request.controller.signal);
        if (!isCurrent(request)) return "failed";
        page = await api.items(id, {
          sessionRevision: detail.sessionRevision,
          limit: TIMELINE_PAGE_SIZE,
        }, request.controller.signal);
      }
      if (!isCurrent(request)) return "failed";
      dispatch({
        type: "load-success",
        detail,
        page,
        preserveSameRevision: quiet,
      });
      return "loaded";
    } catch (reason) {
      if (!isCurrent(request) || isAbort(reason)) return "failed";
      if (
        reason instanceof ApiClientError &&
        reason.status === 404 &&
        reason.code === "session_not_found"
      ) {
        dispatch({ type: "clear" });
        clearMissingSession();
        return "missing";
      }
      dispatch({ type: "load-failure", error: messageFor(reason) });
      return "failed";
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [abortActive, clearMissingSession, isCurrent]);

  const previousSelection = useRef<string | null>(null);
  useEffect(() => {
    const switched = previousSelection.current !== selectedId;
    previousSelection.current = selectedId;
    abortActive();
    if (switched) setAutoRefreshEnabled(false);
    if (selectedId === null) {
      dispatch({ type: "clear" });
      return;
    }
    if (switched) dispatch({ type: "clear" });
    else dispatch({ type: "reset-timeline" });
    void loadSession(selectedId);
    return abortActive;
  }, [abortActive, loadSession, selectedId]);

  const loadMore = useCallback(async () => {
    if (active.current !== null) return;
    const id = selectedIdRef.current;
    const current = stateRef.current.page;
    if (id === null || !current?.hasMore || current.nextAfterOrdinal === null) return;
    const request: ActiveRequest = {
      operation: "page",
      controller: new AbortController(),
      id,
    };
    active.current = request;
    dispatch({ type: "page-start" });
    try {
      const next = await api.items(id, {
        afterOrdinal: current.nextAfterOrdinal,
        sessionRevision: current.sessionRevision,
        limit: TIMELINE_PAGE_SIZE,
      }, request.controller.signal);
      if (isCurrent(request)) dispatch({ type: "page-success", page: next });
    } catch (reason) {
      if (!isCurrent(request)) return;
      if (isStaleSessionRevision(reason)) await loadSession(id);
      else dispatch({ type: "page-failure", error: messageFor(reason) });
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [isCurrent, loadSession]);

  const restartSession = useCallback(
    () => {
      const id = selectedIdRef.current;
      if (id === null) return Promise.resolve<SessionLoadResult>("failed");
      return loadSession(id, true);
    },
    [loadSession],
  );

  const pollSession = useCallback(() => {
    if (active.current !== null) {
      return Promise.resolve<SessionLoadResult>("failed");
    }
    return restartSession();
  }, [restartSession]);

  const setRefreshIntervalSeconds = useCallback((seconds: number) => {
    if (!isValidRefreshInterval(seconds)) return;
    setRefreshIntervalSecondsState(seconds);
    try {
      window.localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(seconds));
    } catch {
      // Storage can be unavailable in privacy modes; the in-memory value still works.
    }
  }, []);

  useSessionPolling(
    autoRefreshEnabled &&
      selectedId !== null &&
      state.detail !== null &&
      state.detail.session.id === selectedId &&
      !state.detail.session.archived,
    pollSession,
    refreshIntervalSeconds * 1_000,
  );

  useEffect(() => abortActive, [abortActive]);

  const selectionChanging = state.detail !== null &&
    state.detail.session.id !== selectedId;
  let operation = state.operation;
  if (selectionChanging) {
    operation = selectedId === null ? null : "open";
  }
  return {
    detail: selectionChanging ? null : state.detail,
    page: selectionChanging ? null : state.page,
    items: selectionChanging ? [] : state.items,
    operation,
    readerLoading: operation === "open" || operation === "page",
    readerError: state.error,
    clearReaderError: () => dispatch({ type: "clear-error" }),
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    refreshIntervalSeconds,
    setRefreshIntervalSeconds,
    loadMore,
    restartSession,
  };
}

function readRefreshIntervalSeconds(): number {
  try {
    const stored = Number(window.localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY));
    return isValidRefreshInterval(stored)
      ? stored
      : DEFAULT_REFRESH_INTERVAL_SECONDS;
  } catch {
    return DEFAULT_REFRESH_INTERVAL_SECONDS;
  }
}

function isValidRefreshInterval(seconds: number): boolean {
  return Number.isInteger(seconds) &&
    seconds >= MIN_REFRESH_INTERVAL_SECONDS &&
    seconds <= MAX_REFRESH_INTERVAL_SECONDS;
}

function reducer(state: ReaderState, action: ReaderAction): ReaderState {
  switch (action.type) {
    case "clear":
      return initialState;
    case "reset-timeline":
      return { ...state, operation: null, page: null, items: [], error: null };
    case "open-start":
      return action.preserve
        ? { ...state, operation: action.operation, error: null }
        : { ...initialState, operation: action.operation };
    case "load-success": {
      const preserve = action.preserveSameRevision &&
        state.page?.sessionRevision === action.page.sessionRevision;
      return {
        operation: null,
        detail: action.detail,
        page: preserve ? state.page : action.page,
        items: preserve ? state.items : action.page.items,
        error: null,
      };
    }
    case "load-failure":
      return { ...state, operation: null, error: action.error };
    case "page-start":
      return { ...state, operation: "page", error: null };
    case "page-success": {
      const seen = new Set(state.items.map((item) => item.id));
      return {
        ...state,
        operation: null,
        page: action.page,
        items: [
          ...state.items,
          ...action.page.items.filter((item) => !seen.has(item.id)),
        ],
        error: null,
      };
    }
    case "page-failure":
      return { ...state, operation: null, error: action.error };
    case "clear-error":
      return { ...state, error: null };
  }
}
