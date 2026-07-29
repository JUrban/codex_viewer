import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  ItemPageResponse,
  SessionDetailResponse,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";
import { isAbort, isStaleGeneration, messageFor } from "./request-errors";
import { useSessionPolling } from "./use-session-polling";

const TIMELINE_PAGE_SIZE = 512;
const POLL_INTERVAL_MS = 8_000;

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
    preserveSameGeneration: boolean;
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
          generation: detail.generation,
          limit: TIMELINE_PAGE_SIZE,
        }, request.controller.signal);
      } catch (reason) {
        if (!isCurrent(request) || !isStaleGeneration(reason)) throw reason;
        detail = await api.session(id, request.controller.signal);
        if (!isCurrent(request)) return "failed";
        page = await api.items(id, {
          generation: detail.generation,
          limit: TIMELINE_PAGE_SIZE,
        }, request.controller.signal);
      }
      if (!isCurrent(request)) return "failed";
      dispatch({
        type: "load-success",
        detail,
        page,
        preserveSameGeneration: quiet,
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
        generation: current.generation,
        limit: TIMELINE_PAGE_SIZE,
      }, request.controller.signal);
      if (isCurrent(request)) dispatch({ type: "page-success", page: next });
    } catch (reason) {
      if (!isCurrent(request)) return;
      if (isStaleGeneration(reason)) await loadSession(id);
      else dispatch({ type: "page-failure", error: messageFor(reason) });
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [isCurrent, loadSession]);

  const restartSession = useCallback(
    () => selectedIdRef.current === null
      ? Promise.resolve<SessionLoadResult>("failed")
      : loadSession(selectedIdRef.current, true),
    [loadSession],
  );

  const pollSession = useCallback(() => (
    active.current === null
      ? restartSession()
      : Promise.resolve<SessionLoadResult>("failed")
  ), [restartSession]);

  useSessionPolling(
    selectedId !== null &&
      state.detail !== null &&
      !state.detail.session.archived &&
      state.detail.session.sourceState !== "unavailable",
    pollSession,
    POLL_INTERVAL_MS,
  );

  useEffect(() => abortActive, [abortActive]);

  const selectionChanging = state.detail !== null &&
    state.detail.session.id !== selectedId;
  const operation = selectionChanging
    ? (selectedId === null ? null : "open")
    : state.operation;
  return {
    detail: selectionChanging ? null : state.detail,
    page: selectionChanging ? null : state.page,
    items: selectionChanging ? [] : state.items,
    operation,
    readerLoading: operation === "open" || operation === "page",
    readerError: state.error,
    clearReaderError: () => dispatch({ type: "clear-error" }),
    loadMore,
    restartSession,
  };
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
      const preserve = action.preserveSameGeneration &&
        state.page?.generation === action.page.generation;
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
