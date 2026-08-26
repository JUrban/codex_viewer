import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  InteractionResponse,
  ItemPagePosition,
  ItemPageQuery,
  ItemPageResponse,
  SessionLiveResponse,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";
import { isAbort, isTimelineConflict, messageFor } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  waitForRetry,
} from "./retry-policy";
import { useSessionLive, type LiveSnapshot } from "./use-session-live";
import { useLiveUpdatesPreference } from "./use-live-updates-preference";
import type { ReaderContext } from "./session-reader-state";

const TIMELINE_PAGE_SIZE = 300;

export type ReaderOperation = "open" | "page" | "previous" | "poll" | "reload" | null;

type PageMerge = "replace" | "append" | "prepend";

interface ReaderState {
  operation: ReaderOperation;
  context: ReaderContext | null;
  items: TimelineItem[];
  interaction: InteractionResponse | null;
  error: string | null;
  missing: boolean;
  timelineConflict: boolean;
  timelineRenderGeneration: number;
  openedPosition: ItemPagePosition | null;
}

type ReaderAction =
  | { type: "start"; operation: Exclude<ReaderOperation, null>; preserve: boolean }
  | {
      type: "success";
      page: ItemPageResponse;
      merge: PageMerge;
      position?: ItemPagePosition;
    }
  | { type: "live-success"; response: SessionLiveResponse }
  | { type: "live-error"; error: string }
  | { type: "page-retry"; error: string }
  | { type: "failure"; error: string; missing: boolean }
  | { type: "timeline-conflict" }
  | { type: "clear-error" };

interface ActiveRequest {
  controller: AbortController;
  generation: number;
}

interface PageRequestMode {
  readonly preserveCurrent: boolean;
  readonly merge: PageMerge;
  readonly position?: ItemPagePosition;
}

const initialState: ReaderState = {
  operation: null,
  context: null,
  items: [],
  interaction: null,
  error: null,
  missing: false,
  timelineConflict: false,
  timelineRenderGeneration: 0,
  openedPosition: null,
};

export function useSessionReader(
  sessionId: string,
  openPosition: ItemPagePosition = "beginning",
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useLiveUpdatesPreference();
  const active = useRef<ActiveRequest | null>(null);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const markTimelineConflict = useCallback(() => {
    generation.current += 1;
    active.current?.controller.abort();
    active.current = null;
    dispatch({ type: "timeline-conflict" });
  }, []);

  const isCurrent = useCallback((request: ActiveRequest) => (
    active.current === request &&
    request.generation === generation.current &&
    !request.controller.signal.aborted
  ), []);

  const requestPage = useCallback(async (
    operation: Exclude<ReaderOperation, null>,
    query: ItemPageQuery,
    mode: PageRequestMode,
  ): Promise<boolean> => {
    if (active.current !== null) return false;
    const request: ActiveRequest = {
      controller: new AbortController(),
      generation: generation.current,
    };
    active.current = request;
    dispatch({ type: "start", operation, preserve: mode.preserveCurrent });
    let retryMs = INITIAL_RETRY_MS;
    try {
      while (isCurrent(request)) {
        try {
          const page = await api.items(sessionId, {
            ...query,
            limit: TIMELINE_PAGE_SIZE,
          }, request.controller.signal);
          if (!isCurrent(request)) return false;
          dispatch({
            type: "success",
            page,
            merge: mode.merge,
            position: mode.position,
          });
          return true;
        } catch (reason) {
          if (!isCurrent(request) || isAbort(reason)) return false;
          if (isTimelineConflict(reason)) {
            markTimelineConflict();
            return false;
          }
          const retryablePagination = (
            operation === "page" || operation === "previous" || operation === "poll"
          ) &&
            isRetryableRequestError(reason);
          if (!retryablePagination) throw reason;
          dispatch({ type: "page-retry", error: messageFor(reason) });
          await waitForRetry(retryMs, request.controller.signal);
          retryMs = nextRetryMs(retryMs);
        }
      }
      return false;
    } catch (reason) {
      if (!isCurrent(request) || isAbort(reason)) return false;
      const missing = reason instanceof ApiClientError &&
        reason.status === 404 && reason.code === "session_not_found";
      dispatch({ type: "failure", error: messageFor(reason), missing });
      return false;
    } finally {
      if (active.current === request) active.current = null;
    }
  }, [isCurrent, markTimelineConflict, sessionId]);

  useEffect(() => {
    generation.current += 1;
    active.current?.controller.abort();
    active.current = null;
    void requestPage("open", initialQuery(openPosition), {
      preserveCurrent: false,
      merge: "replace",
      position: openPosition,
    });
    return () => {
      generation.current += 1;
      active.current?.controller.abort();
      active.current = null;
    };
  }, [openPosition, requestPage]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.context === null || !current.context.hasMore || current.timelineConflict) {
      return Promise.resolve(false);
    }
    return requestPage("page", { cursor: current.context.cursor }, {
      preserveCurrent: true,
      merge: "append",
    });
  }, [requestPage]);

  const loadPrevious = useCallback(() => {
    const current = stateRef.current;
    if (current.context === null || current.context.previousCursor === null ||
      current.timelineConflict) {
      return Promise.resolve(false);
    }
    return requestPage("previous", { before: current.context.previousCursor }, {
      preserveCurrent: true,
      merge: "prepend",
    });
  }, [requestPage]);

  const retryOpen = useCallback(() => requestPage("open", initialQuery(openPosition), {
    preserveCurrent: false,
    merge: "replace",
    position: openPosition,
  }), [openPosition, requestPage]);

  const reloadLatest = useCallback(() => {
    active.current?.controller.abort();
    active.current = null;
    generation.current += 1;
    return requestPage("reload", initialQuery(openPosition), {
      preserveCurrent: true,
      merge: "replace",
      position: openPosition,
    });
  }, [openPosition, requestPage]);

  const onLiveUpdate = useCallback(async (
    response: SessionLiveResponse,
    expected: LiveSnapshot,
  ) => {
    const current = stateRef.current;
    if (current.context === null || current.timelineConflict ||
      current.context.cursor !== expected.cursor ||
      current.context.liveRevision !== expected.liveRevision ||
      response.cursor !== expected.cursor) return;
    if (response.hasMore) {
      const loaded = await requestPage("poll", { cursor: expected.cursor }, {
        preserveCurrent: true,
        merge: "append",
      });
      if (!loaded && !stateRef.current.timelineConflict) setAutoRefreshEnabled(false);
      return;
    }
    dispatch({ type: "live-success", response });
  }, [requestPage]);

  useSessionLive({
    sessionId,
    enabled: autoRefreshEnabled && state.operation === null &&
      state.context !== null && state.context.session.id === sessionId &&
      !state.context.session.archived &&
      !state.timelineConflict,
    snapshot: state.context === null ? null : {
      cursor: state.context.cursor,
      liveRevision: state.context.liveRevision,
    },
    onUpdate: onLiveUpdate,
    onTimelineConflict: markTimelineConflict,
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
      state.operation === "previous" || state.operation === "reload",
    readerError: state.error,
    missing: state.missing,
    timelineConflict: state.timelineConflict,
    timelineRenderGeneration: state.timelineRenderGeneration,
    openedPosition: state.openedPosition,
    clearReaderError: () => dispatch({ type: "clear-error" }),
    autoRefreshEnabled: autoRefreshEnabled && state.context?.session.archived !== true,
    setAutoRefreshEnabled,
    loadMore,
    loadPrevious,
    retryOpen,
    markTimelineConflict,
    refreshLatest: reloadLatest,
  };
}

function reducer(state: ReaderState, action: ReaderAction): ReaderState {
  switch (action.type) {
    case "start":
      return action.preserve
        ? { ...state, operation: action.operation, error: null }
        : {
            ...initialState,
            operation: action.operation,
            timelineRenderGeneration: state.timelineRenderGeneration,
          };
    case "success": {
      if (action.merge === "prepend" && state.context !== null) {
        return {
          ...state,
          operation: null,
          context: {
            ...state.context,
            previousCursor: action.page.previousCursor,
          },
          items: prependUnique(state.items, action.page.items),
          error: null,
          missing: false,
          timelineConflict: false,
        };
      }
      const context: ReaderContext = {
        session: action.page.session,
        cursor: action.page.cursor,
        previousCursor: action.merge === "append"
          ? state.context?.previousCursor ?? action.page.previousCursor
          : action.page.previousCursor,
        hasMore: action.page.hasMore,
        liveRevision: action.page.liveRevision,
      };
      return {
        ...state,
        operation: null,
        context,
        items: action.merge === "replace"
          ? action.page.items
          : appendUnique(state.items, action.page.items),
        interaction: action.page.interaction,
        error: null,
        missing: false,
        timelineConflict: false,
        timelineRenderGeneration: action.merge === "replace" && state.timelineConflict
          ? state.timelineRenderGeneration + 1
          : state.timelineRenderGeneration,
        openedPosition: action.merge === "replace"
          ? action.position ?? "beginning"
          : state.openedPosition,
      };
    }
    case "live-success":
      if (state.context === null || action.response.cursor !== state.context.cursor) return state;
      return {
        ...state,
        context: {
          session: action.response.session,
          cursor: action.response.cursor,
          previousCursor: state.context.previousCursor,
          hasMore: action.response.hasMore,
          liveRevision: action.response.liveRevision,
        },
        interaction: action.response.interaction,
        error: null,
        missing: false,
      };
    case "live-error":
      return { ...state, error: action.error };
    case "page-retry":
      return { ...state, error: action.error };
    case "failure":
      return { ...state, operation: null, error: action.error, missing: action.missing };
    case "timeline-conflict":
      return { ...state, operation: null, error: null, timelineConflict: true };
    case "clear-error":
      return state.error === null ? state : { ...state, error: null };
  }
}

function appendUnique(existing: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const additions = incoming.filter((item) => !seen.has(item.id));
  return additions.length === 0 ? existing : [...existing, ...additions];
}

function prependUnique(existing: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const additions = incoming.filter((item) => !seen.has(item.id));
  return additions.length === 0 ? existing : [...additions, ...existing];
}

function initialQuery(position: ItemPagePosition): ItemPageQuery {
  return position === "latest" ? { position } : {};
}
