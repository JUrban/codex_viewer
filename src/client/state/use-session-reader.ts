import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  InteractionResponse,
  ItemPageResponse,
  SessionLiveResponse,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";
import { isAbort, isTimelineChanged, messageFor } from "./request-errors";
import { useSessionLive, type LiveSnapshot } from "./use-session-live";
import type { ReaderContext } from "./session-reader-state";

const TIMELINE_PAGE_SIZE = 300;

export type ReaderOperation = "open" | "page" | "poll" | "reload" | null;

interface ReaderState {
  operation: ReaderOperation;
  context: ReaderContext | null;
  items: TimelineItem[];
  interaction: InteractionResponse | null;
  error: string | null;
  missing: boolean;
  timelineChanged: boolean;
  timelineGeneration: number;
}

type ReaderAction =
  | { type: "start"; operation: Exclude<ReaderOperation, null>; preserve: boolean }
  | { type: "success"; page: ItemPageResponse; replace: boolean }
  | { type: "live-success"; response: SessionLiveResponse }
  | { type: "live-error"; error: string }
  | { type: "failure"; error: string; missing: boolean }
  | { type: "timeline-changed" }
  | { type: "clear-error" };

interface ActiveRequest {
  controller: AbortController;
  generation: number;
}

interface PageRequestMode {
  readonly preserveCurrent: boolean;
  readonly replaceItems: boolean;
}

const initialState: ReaderState = {
  operation: null,
  context: null,
  items: [],
  interaction: null,
  error: null,
  missing: false,
  timelineChanged: false,
  timelineGeneration: 0,
};

export function useSessionReader(sessionId: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const active = useRef<ActiveRequest | null>(null);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const markTimelineChanged = useCallback(() => {
    generation.current += 1;
    active.current?.controller.abort();
    active.current = null;
    dispatch({ type: "timeline-changed" });
  }, []);

  const isCurrent = useCallback((request: ActiveRequest) => (
    active.current === request &&
    request.generation === generation.current &&
    !request.controller.signal.aborted
  ), []);

  const requestPage = useCallback(async (
    operation: Exclude<ReaderOperation, null>,
    cursor: ReaderContext["cursor"] | undefined,
    mode: PageRequestMode,
  ): Promise<boolean> => {
    if (active.current !== null) return false;
    const request: ActiveRequest = {
      controller: new AbortController(),
      generation: generation.current,
    };
    active.current = request;
    dispatch({ type: "start", operation, preserve: mode.preserveCurrent });
    try {
      const page = await api.items(sessionId, {
        cursor,
        limit: TIMELINE_PAGE_SIZE,
      }, request.controller.signal);
      if (!isCurrent(request)) return false;
      dispatch({ type: "success", page, replace: mode.replaceItems });
      return true;
    } catch (reason) {
      if (!isCurrent(request) || isAbort(reason)) return false;
      if (isTimelineChanged(reason)) {
        markTimelineChanged();
        return false;
      }
      const missing = reason instanceof ApiClientError &&
        reason.status === 404 && reason.code === "session_not_found";
      dispatch({ type: "failure", error: messageFor(reason), missing });
      return false;
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [isCurrent, markTimelineChanged, sessionId]);

  useEffect(() => {
    setAutoRefreshEnabled(false);
    generation.current += 1;
    active.current?.controller.abort();
    active.current = null;
    void requestPage("open", undefined, {
      preserveCurrent: false,
      replaceItems: true,
    });
    return () => {
      generation.current += 1;
      active.current?.controller.abort();
      active.current = null;
    };
  }, [requestPage]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.context === null || !current.context.hasMore || current.timelineChanged) {
      return Promise.resolve(false);
    }
    return requestPage("page", current.context.cursor, {
      preserveCurrent: true,
      replaceItems: false,
    });
  }, [requestPage]);

  const retryOpen = useCallback(() => requestPage("open", undefined, {
    preserveCurrent: false,
    replaceItems: true,
  }), [requestPage]);

  const reloadLatest = useCallback(() => {
    active.current?.controller.abort();
    active.current = null;
    generation.current += 1;
    return requestPage("reload", undefined, {
      preserveCurrent: true,
      replaceItems: true,
    });
  }, [requestPage]);

  const onLiveUpdate = useCallback(async (
    response: SessionLiveResponse,
    expected: LiveSnapshot,
  ) => {
    const current = stateRef.current;
    if (current.context === null || current.timelineChanged ||
      current.context.cursor !== expected.cursor ||
      current.context.liveRevision !== expected.liveRevision ||
      response.cursor !== expected.cursor) return;
    if (response.hasMore) {
      await requestPage("poll", expected.cursor, {
        preserveCurrent: true,
        replaceItems: false,
      });
      return;
    }
    dispatch({ type: "live-success", response });
  }, [requestPage]);

  useSessionLive({
    sessionId,
    enabled: autoRefreshEnabled && state.operation === null &&
      state.context !== null && state.context.session.id === sessionId &&
      !state.context.session.archived &&
      !state.timelineChanged,
    snapshot: state.context === null ? null : {
      cursor: state.context.cursor,
      liveRevision: state.context.liveRevision,
    },
    onUpdate: onLiveUpdate,
    onConflict: markTimelineChanged,
    onError: (reason, terminal) => {
      dispatch({ type: "live-error", error: messageFor(reason) });
      if (terminal) setAutoRefreshEnabled(false);
    },
    onSuccess: () => dispatch({ type: "clear-error" }),
  });

  return {
    context: state.context,
    items: state.items,
    interaction: state.interaction,
    operation: state.operation,
    readerLoading: state.operation === "open" || state.operation === "page" ||
      state.operation === "reload",
    readerError: state.error,
    missing: state.missing,
    prefixChanged: state.timelineChanged,
    timelineGeneration: state.timelineGeneration,
    clearReaderError: () => dispatch({ type: "clear-error" }),
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    loadMore,
    retryOpen,
    markTimelineChanged,
    refreshLatest: reloadLatest,
  };
}

function reducer(state: ReaderState, action: ReaderAction): ReaderState {
  switch (action.type) {
    case "start":
      return action.preserve
        ? { ...state, operation: action.operation, error: null }
        : { ...initialState, operation: action.operation, timelineGeneration: state.timelineGeneration };
    case "success": {
      const context: ReaderContext = {
        session: action.page.session,
        cursor: action.page.cursor,
        hasMore: action.page.hasMore,
        liveRevision: action.page.liveRevision,
      };
      return {
        ...state,
        operation: null,
        context,
        items: action.replace ? action.page.items : appendUnique(state.items, action.page.items),
        interaction: action.page.interaction,
        error: null,
        missing: false,
        timelineChanged: false,
        timelineGeneration: action.replace && state.timelineChanged
          ? state.timelineGeneration + 1
          : state.timelineGeneration,
      };
    }
    case "live-success":
      if (state.context === null || action.response.cursor !== state.context.cursor) return state;
      return {
        ...state,
        context: {
          session: action.response.session,
          cursor: action.response.cursor,
          hasMore: action.response.hasMore,
          liveRevision: action.response.liveRevision,
        },
        interaction: action.response.interaction,
        error: null,
        missing: false,
      };
    case "live-error":
      return { ...state, error: action.error };
    case "failure":
      return { ...state, operation: null, error: action.error, missing: action.missing };
    case "timeline-changed":
      return { ...state, operation: null, error: null, timelineChanged: true };
    case "clear-error":
      return state.error === null ? state : { ...state, error: null };
  }
}

function appendUnique(existing: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const additions = incoming.filter((item) => !seen.has(item.id));
  return additions.length === 0 ? existing : [...existing, ...additions];
}
