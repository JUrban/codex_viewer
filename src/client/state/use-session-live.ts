import { useEffect, useRef } from "react";
import type {
  LiveRevision,
  SessionLiveResponse,
  TimelineCursor,
} from "../../shared/api-contract";
import { api } from "../api/client";
import { isAbort, isTimelineConflict } from "./request-errors";
import {
  INITIAL_RETRY_MS,
  isRetryableRequestError,
  nextRetryMs,
  retryDelayMs,
} from "./retry-policy";

export interface LiveSnapshot {
  readonly cursor: TimelineCursor;
  readonly liveRevision: LiveRevision;
}

interface SessionLiveOptions {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly snapshot: LiveSnapshot | null;
  readonly onUpdate: (response: SessionLiveResponse, expected: LiveSnapshot) => Promise<void> | void;
  readonly onTimelineConflict: () => void;
  readonly onError: (reason: unknown, terminal: boolean) => void;
  readonly onSuccess?: () => void;
}

export function useSessionLive({
  sessionId,
  enabled,
  snapshot,
  onUpdate,
  onTimelineConflict,
  onError,
  onSuccess,
}: SessionLiveOptions): void {
  const callbacks = useRef({ onUpdate, onTimelineConflict, onError, onSuccess });
  callbacks.current = { onUpdate, onTimelineConflict, onError, onSuccess };

  useEffect(() => {
    if (!enabled || snapshot === null) return;
    let disposed = false;
    let controller: AbortController | null = null;
    let retryMs = INITIAL_RETRY_MS;
    let wakeVisible: (() => void) | null = null;
    let cancelDelay: (() => void) | null = null;

    const onVisibility = () => {
      if (document.hidden) controller?.abort();
      else wakeVisible?.();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const run = async () => {
      while (!disposed) {
        if (document.hidden) {
          await new Promise<void>((resolve) => { wakeVisible = resolve; });
          wakeVisible = null;
          if (disposed) return;
        }
        const expected = snapshot;
        controller = new AbortController();
        try {
          const response = await api.live(sessionId, {
            cursor: expected.cursor,
            after: expected.liveRevision,
          }, controller.signal);
          if (disposed || controller.signal.aborted) continue;
          retryMs = INITIAL_RETRY_MS;
          callbacks.current.onSuccess?.();
          if (response !== null) {
            await callbacks.current.onUpdate(response, expected);
            return;
          }
        } catch (reason) {
          if (disposed) return;
          if (isAbort(reason)) continue;
          if (isTimelineConflict(reason)) {
            callbacks.current.onTimelineConflict();
            return;
          }
          const retryable = isRetryableRequestError(reason);
          callbacks.current.onError(reason, !retryable);
          if (!retryable) return;
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, retryDelayMs(retryMs));
            cancelDelay = () => {
              window.clearTimeout(timer);
              resolve();
            };
          });
          cancelDelay = null;
          retryMs = nextRetryMs(retryMs);
        } finally {
          controller = null;
        }
      }
    };

    void run();
    return () => {
      disposed = true;
      controller?.abort();
      cancelDelay?.();
      wakeVisible?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, sessionId, snapshot?.cursor, snapshot?.liveRevision]);
}
