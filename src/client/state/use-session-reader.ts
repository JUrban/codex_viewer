import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  ItemPageResponse,
  SessionDetailResponse,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";
import { useSessionPolling } from "./use-session-polling";

const TIMELINE_PAGE_SIZE = 512;
const POLL_INTERVAL_MS = 8_000;

type ReaderMode = "idle" | "opening" | "ready" | "paging" | "refreshing";

interface ReaderState {
  mode: ReaderMode;
  detail: SessionDetailResponse | null;
  page: ItemPageResponse | null;
  items: TimelineItem[];
  error: string | null;
}

type ReaderAction =
  | { type: "clear" }
  | { type: "reset-timeline" }
  | { type: "open-start"; preserve: boolean }
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

const initialState: ReaderState = {
  mode: "idle",
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
  const detailAbort = useRef<AbortController | null>(null);
  const timelineAbort = useRef<AbortController | null>(null);
  const pageAbort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const selectedIdRef = useRef(selectedId);
  const stateRef = useRef(state);
  selectedIdRef.current = selectedId;
  stateRef.current = state;

  const abortAll = useCallback(() => {
    detailAbort.current?.abort();
    timelineAbort.current?.abort();
    pageAbort.current?.abort();
    detailAbort.current = null;
    timelineAbort.current = null;
    pageAbort.current = null;
    sequence.current += 1;
  }, []);

  const loadSession = useCallback(async (
    id: string,
    quiet = false,
  ): Promise<SessionLoadResult> => {
    detailAbort.current?.abort();
    timelineAbort.current?.abort();
    pageAbort.current?.abort();
    const request = ++sequence.current;
    dispatch({
      type: "open-start",
      preserve: quiet || stateRef.current.detail?.session.id === id,
    });
    const detailController = new AbortController();
    detailAbort.current = detailController;
    try {
      let detail = await api.session(id, detailController.signal);
      if (request !== sequence.current) return "failed";
      const timelineController = new AbortController();
      timelineAbort.current = timelineController;
      let page: ItemPageResponse;
      try {
        page = await api.items(id, {
          generation: detail.generation,
          limit: TIMELINE_PAGE_SIZE,
        }, timelineController.signal);
      } catch (reason) {
        if (!isStaleGeneration(reason)) throw reason;
        const retryController = new AbortController();
        detailAbort.current = retryController;
        detail = await api.session(id, retryController.signal);
        page = await api.items(id, {
          generation: detail.generation,
          limit: TIMELINE_PAGE_SIZE,
        }, timelineController.signal);
      }
      if (request !== sequence.current) return "failed";
      dispatch({
        type: "load-success",
        detail,
        page,
        preserveSameGeneration: quiet,
      });
      return "loaded";
    } catch (reason) {
      if (request !== sequence.current || isAbort(reason)) return "failed";
      if (
        reason instanceof ApiClientError &&
        reason.status === 404 &&
        reason.code === "session_not_found" &&
        selectedIdRef.current === id
      ) {
        dispatch({ type: "clear" });
        clearMissingSession();
        return "missing";
      }
      dispatch({ type: "load-failure", error: messageFor(reason) });
      return "failed";
    } finally {
      if (request === sequence.current) {
        detailAbort.current = null;
        timelineAbort.current = null;
      }
    }
  }, [clearMissingSession]);

  const previousSelection = useRef<string | null>(null);
  useEffect(() => {
    const switched = previousSelection.current !== selectedId;
    previousSelection.current = selectedId;
    abortAll();
    if (selectedId === null) {
      dispatch({ type: "clear" });
      return;
    }
    if (switched) dispatch({ type: "clear" });
    else dispatch({ type: "reset-timeline" });
    void loadSession(selectedId);
    return abortAll;
  }, [abortAll, loadSession, selectedId]);

  const loadMore = useCallback(async () => {
    const id = selectedIdRef.current;
    const current = stateRef.current.page;
    if (id === null || !current?.hasMore || current.nextAfterOrdinal === null) return;
    pageAbort.current?.abort();
    const controller = new AbortController();
    pageAbort.current = controller;
    const request = ++sequence.current;
    dispatch({ type: "page-start" });
    try {
      const next = await api.items(id, {
        afterOrdinal: current.nextAfterOrdinal,
        generation: current.generation,
        limit: TIMELINE_PAGE_SIZE,
      }, controller.signal);
      if (request === sequence.current) dispatch({ type: "page-success", page: next });
    } catch (reason) {
      if (controller.signal.aborted || request !== sequence.current) return;
      if (isStaleGeneration(reason)) await loadSession(id);
      else dispatch({ type: "page-failure", error: messageFor(reason) });
    } finally {
      if (pageAbort.current === controller) pageAbort.current = null;
    }
  }, [loadSession]);

  const restartSession = useCallback(
    () => selectedIdRef.current === null
      ? Promise.resolve<SessionLoadResult>("failed")
      : loadSession(selectedIdRef.current, true),
    [loadSession],
  );

  const pollSession = useCallback(() => {
    if (
      detailAbort.current !== null ||
      timelineAbort.current !== null ||
      pageAbort.current !== null
    ) {
      return Promise.resolve<SessionLoadResult>("failed");
    }
    return restartSession();
  }, [restartSession]);

  useSessionPolling(
    selectedId !== null &&
      state.detail !== null &&
      !state.detail.session.archived &&
      state.detail.session.sourceState !== "unavailable",
    pollSession,
    POLL_INTERVAL_MS,
  );

  useEffect(() => abortAll, [abortAll]);

  return {
    detail: state.detail,
    page: state.page,
    items: state.items,
    readerLoading: state.mode === "opening" || state.mode === "paging",
    readerRefreshing: state.mode === "refreshing",
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
      return { ...state, page: null, items: [], error: null };
    case "open-start":
      return action.preserve
        ? { ...state, mode: "refreshing", error: null }
        : { ...initialState, mode: "opening" };
    case "load-success": {
      const preserve = action.preserveSameGeneration &&
        state.page?.generation === action.page.generation;
      return {
        mode: "ready",
        detail: action.detail,
        page: preserve ? state.page : action.page,
        items: preserve ? state.items : action.page.items,
        error: null,
      };
    }
    case "load-failure":
      return { ...state, mode: "ready", error: action.error };
    case "page-start":
      return { ...state, mode: "paging", error: null };
    case "page-success": {
      const seen = new Set(state.items.map((item) => item.id));
      return {
        ...state,
        mode: "ready",
        page: action.page,
        items: [
          ...state.items,
          ...action.page.items.filter((item) => !seen.has(item.id)),
        ],
        error: null,
      };
    }
    case "page-failure":
      return { ...state, mode: "ready", error: action.error };
    case "clear-error":
      return { ...state, error: null };
  }
}

function messageFor(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return "The local session reader could not complete the request.";
}

function isStaleGeneration(reason: unknown): reason is ApiClientError {
  return reason instanceof ApiClientError && reason.code === "stale_generation";
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}
