import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  InteractionResponse,
  ItemPageResponse,
  SessionReadContext,
  SessionReadCursor,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";
import {
  isAbort,
  isStaleTimelinePrefix,
  messageFor,
} from "./request-errors";
import { useSessionPolling } from "./use-session-polling";

const TIMELINE_PAGE_SIZE = 300;
const DEFAULT_REFRESH_INTERVAL_SECONDS = 2;
const MIN_REFRESH_INTERVAL_SECONDS = 1;
const MAX_REFRESH_INTERVAL_SECONDS = 3_600;
const REFRESH_INTERVAL_STORAGE_KEY =
  "codex-sessions-reader.refresh-interval-seconds.v1";
const LIVE_UPDATES_STORAGE_KEY_PREFIX =
  "codex-sessions-reader.live-updates.v1:";

export type ReaderOperation = "open" | "page" | "refresh" | null;

interface ReaderState {
  operation: ReaderOperation;
  context: SessionReadContext | null;
  items: TimelineItem[];
  interaction: InteractionResponse | null;
  error: string | null;
  prefixChanged: boolean;
  timelineGeneration: number;
  tailFollowing: boolean;
}

type ReaderAction =
  | { type: "clear" }
  | {
    type: "open-start";
    operation: "open" | "refresh";
    preserve: boolean;
  }
  | {
    type: "open-success";
    context: SessionReadContext;
    items: TimelineItem[];
    interaction: InteractionResponse;
  }
  | { type: "refresh-start" }
  | {
    type: "refresh-success";
    context: SessionReadContext;
    tailPage: ItemPageResponse | null;
    interaction: InteractionResponse;
  }
  | { type: "prefix-changed" }
  | { type: "load-failure"; error: string }
  | { type: "page-start" }
  | { type: "page-success"; page: ItemPageResponse }
  | { type: "page-failure"; error: string }
  | {
    type: "adopt-context";
    expected: SessionReadCursor;
    context: SessionReadContext;
  }
  | { type: "clear-error" };

interface ActiveRequest {
  operation: Exclude<ReaderOperation, null>;
  controller: AbortController;
  id: string;
}

const initialState: ReaderState = {
  operation: null,
  context: null,
  items: [],
  interaction: null,
  error: null,
  prefixChanged: false,
  timelineGeneration: 0,
  tailFollowing: false,
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

  const handleMissing = useCallback((request: ActiveRequest, reason: unknown) => {
    if (
      isCurrent(request) &&
      reason instanceof ApiClientError &&
      reason.status === 404 &&
      reason.code === "session_not_found"
    ) {
      dispatch({ type: "clear" });
      clearMissingSession();
      return true;
    }
    return false;
  }, [clearMissingSession, isCurrent]);

  const openSession = useCallback(async (
    id: string,
    preserve = false,
  ): Promise<SessionLoadResult> => {
    abortActive();
    const operation: "open" | "refresh" = preserve ? "refresh" : "open";
    const request: ActiveRequest = {
      operation,
      controller: new AbortController(),
      id,
    };
    active.current = request;
    dispatch({ type: "open-start", operation, preserve });
    try {
      const detail = await api.session(id, {}, request.controller.signal);
      if (!isCurrent(request)) return "failed";
      const page = await api.items(id, {
        cursor: detail.context.cursor,
        limit: TIMELINE_PAGE_SIZE,
      }, request.controller.signal);
      if (!isCurrent(request)) return "failed";
      dispatch({
        type: "open-success",
        context: page.context,
        items: page.items,
        interaction: page.interaction,
      });
      return "loaded";
    } catch (reason) {
      if (!isCurrent(request) || isAbort(reason)) return "failed";
      if (handleMissing(request, reason)) return "missing";
      dispatch({ type: "load-failure", error: messageFor(reason) });
      return "failed";
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [abortActive, handleMissing, isCurrent]);

  const refreshSession = useCallback(async (
    replaceActive: boolean,
  ): Promise<SessionLoadResult> => {
    if (active.current !== null) {
      if (!replaceActive) return "failed";
      abortActive();
    }
    const id = selectedIdRef.current;
    const current = stateRef.current;
    if (
      id === null ||
      current.context === null ||
      current.prefixChanged
    ) {
      return "failed";
    }
    const request: ActiveRequest = {
      operation: "refresh",
      controller: new AbortController(),
      id,
    };
    active.current = request;
    dispatch({ type: "refresh-start" });
    try {
      const detail = await api.session(
        id,
        { cursor: current.context.cursor },
        request.controller.signal,
      );
      if (!isCurrent(request)) return "failed";
      const tailPage = current.tailFollowing && detail.context.hasMore
        ? await api.items(id, {
            cursor: detail.context.cursor,
            limit: TIMELINE_PAGE_SIZE,
          }, request.controller.signal)
        : null;
      if (!isCurrent(request)) return "failed";
      dispatch({
        type: "refresh-success",
        context: tailPage?.context ?? detail.context,
        tailPage,
        interaction: tailPage?.interaction ?? detail.interaction,
      });
      return "loaded";
    } catch (reason) {
      if (!isCurrent(request) || isAbort(reason)) return "failed";
      if (handleMissing(request, reason)) return "missing";
      if (isStaleTimelinePrefix(reason)) {
        dispatch({ type: "prefix-changed" });
        return "failed";
      }
      dispatch({ type: "load-failure", error: messageFor(reason) });
      return "failed";
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [abortActive, handleMissing, isCurrent]);

  const pollSession = useCallback(
    () => refreshSession(false),
    [refreshSession],
  );

  const refreshSelectedSession = useCallback(
    () => refreshSession(true),
    [refreshSession],
  );

  const previousSelection = useRef<string | null>(null);
  useEffect(() => {
    const switched = previousSelection.current !== selectedId;
    previousSelection.current = selectedId;
    abortActive();
    if (switched) setAutoRefreshEnabled(readLiveUpdatesEnabled(selectedId));
    if (selectedId === null) {
      dispatch({ type: "clear" });
      return;
    }
    if (switched) dispatch({ type: "clear" });
    void openSession(selectedId);
    return abortActive;
  }, [abortActive, openSession, selectedId]);

  const loadMore = useCallback(async () => {
    if (active.current !== null) return;
    const id = selectedIdRef.current;
    const current = stateRef.current;
    if (
      id === null ||
      current.context === null ||
      current.prefixChanged ||
      !current.context.hasMore
    ) {
      return;
    }
    const request: ActiveRequest = {
      operation: "page",
      controller: new AbortController(),
      id,
    };
    active.current = request;
    dispatch({ type: "page-start" });
    try {
      const page = await api.items(id, {
        cursor: current.context.cursor,
        limit: TIMELINE_PAGE_SIZE,
      }, request.controller.signal);
      if (isCurrent(request)) dispatch({ type: "page-success", page });
    } catch (reason) {
      if (!isCurrent(request) || isAbort(reason)) return;
      if (isStaleTimelinePrefix(reason)) {
        dispatch({ type: "prefix-changed" });
      } else {
        dispatch({ type: "page-failure", error: messageFor(reason) });
      }
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [isCurrent]);

  const refreshLatest = useCallback(() => {
    const id = selectedIdRef.current;
    if (id === null) return Promise.resolve<SessionLoadResult>("failed");
    return openSession(id, true);
  }, [openSession]);

  const markPrefixChanged = useCallback(() => {
    abortActive();
    dispatch({ type: "prefix-changed" });
  }, [abortActive]);

  const adoptContext = useCallback((
    expected: SessionReadCursor,
    context: SessionReadContext,
  ) => {
    dispatch({ type: "adopt-context", expected, context });
  }, []);

  const setRefreshIntervalSeconds = useCallback((seconds: number) => {
    if (!isValidRefreshInterval(seconds)) return;
    setRefreshIntervalSecondsState(seconds);
    try {
      window.localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(seconds));
    } catch {
      // Storage can be unavailable in privacy modes; the in-memory value still works.
    }
  }, []);

  const setLiveUpdatesEnabled = useCallback((enabled: boolean) => {
    const id = selectedIdRef.current;
    setAutoRefreshEnabled(enabled);
    if (id === null) return;
    try {
      const key = `${LIVE_UPDATES_STORAGE_KEY_PREFIX}${id}`;
      if (enabled) window.localStorage.setItem(key, "1");
      else window.localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable; the in-memory setting remains usable.
    }
  }, []);

  useSessionPolling(
    autoRefreshEnabled &&
      selectedId !== null &&
      state.context !== null &&
      state.context.session.id === selectedId &&
      !state.context.session.archived,
    pollSession,
    refreshIntervalSeconds * 1_000,
  );

  useEffect(() => abortActive, [abortActive]);

  const selectionChanging = state.context !== null &&
    state.context.session.id !== selectedId;
  let operation = state.operation;
  if (selectionChanging) {
    operation = selectedId === null ? null : "open";
  }
  return {
    context: selectionChanging ? null : state.context,
    items: selectionChanging ? [] : state.items,
    interaction: selectionChanging ? null : state.interaction,
    operation,
    readerLoading: operation === "open" || operation === "page",
    readerError: state.error,
    prefixChanged: state.prefixChanged,
    timelineGeneration: state.timelineGeneration,
    clearReaderError: () => dispatch({ type: "clear-error" }),
    autoRefreshEnabled,
    setAutoRefreshEnabled: setLiveUpdatesEnabled,
    refreshIntervalSeconds,
    setRefreshIntervalSeconds,
    loadMore,
    refreshSession: refreshSelectedSession,
    markPrefixChanged,
    adoptContext,
    refreshLatest,
  };
}

function readLiveUpdatesEnabled(sessionId: string | null): boolean {
  if (sessionId === null) return false;
  try {
    return window.localStorage.getItem(
      `${LIVE_UPDATES_STORAGE_KEY_PREFIX}${sessionId}`,
    ) === "1";
  } catch {
    return false;
  }
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
    case "open-start":
      return action.preserve
        ? { ...state, operation: action.operation, error: null }
        : { ...initialState, operation: action.operation };
    case "open-success":
      return {
        ...initialState,
        context: action.context,
        items: action.items,
        interaction: action.interaction,
        timelineGeneration: state.prefixChanged
          ? state.timelineGeneration + 1
          : state.timelineGeneration,
        tailFollowing: !action.context.hasMore,
      };
    case "refresh-start":
      return { ...state, operation: "refresh", error: null };
    case "refresh-success":
      return {
        ...state,
        operation: null,
        context: action.context,
        interaction: action.interaction,
        items: action.tailPage
          ? appendUnique(state.items, action.tailPage.items)
          : state.items,
        error: null,
        prefixChanged: false,
      };
    case "prefix-changed":
      return { ...state, operation: null, error: null, prefixChanged: true };
    case "load-failure":
      return { ...state, operation: null, error: action.error };
    case "page-start":
      return { ...state, operation: "page", error: null };
    case "page-success":
      return {
        ...state,
        operation: null,
        context: action.page.context,
        interaction: action.page.interaction,
        items: appendUnique(state.items, action.page.items),
        error: null,
        tailFollowing: !action.page.context.hasMore,
      };
    case "page-failure":
      return { ...state, operation: null, error: action.error };
    case "adopt-context":
      return !state.prefixChanged &&
          state.context !== null &&
          sameCursor(state.context.cursor, action.expected) &&
          action.context.cursor.throughOrdinal ===
            state.context.cursor.throughOrdinal
        ? { ...state, context: action.context }
        : state;
    case "clear-error":
      return { ...state, error: null };
  }
}

function sameCursor(left: SessionReadCursor, right: SessionReadCursor): boolean {
  return left.sessionRevision === right.sessionRevision &&
    left.throughOrdinal === right.throughOrdinal &&
    left.timelinePrefixRevision === right.timelinePrefixRevision;
}

function appendUnique(existing: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const additions = incoming.filter((item) => !seen.has(item.id));
  return additions.length === 0 ? existing : [...existing, ...additions];
}
