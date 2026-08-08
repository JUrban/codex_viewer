import { useEffect, useRef } from "react";
import type {
  LiveRevision,
  SessionLiveResponse,
  TimelineCursor,
} from "../../shared/api-contract";
import { api, ApiClientError } from "../api/client";
import { isAbort, isTimelineChanged } from "./request-errors";

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const RETRY_JITTER = 0.2;

export interface LiveSnapshot {
  readonly cursor: TimelineCursor;
  readonly liveRevision: LiveRevision;
}

interface SessionLiveOptions {
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly snapshot: LiveSnapshot | null;
  readonly onUpdate: (response: SessionLiveResponse, expected: LiveSnapshot) => Promise<void> | void;
  readonly onConflict: () => void;
  readonly onError: (reason: unknown, terminal: boolean) => void;
  readonly onSuccess?: () => void;
}

export function useSessionLive({
  sessionId,
  enabled,
  snapshot,
  onUpdate,
  onConflict,
  onError,
  onSuccess,
}: SessionLiveOptions): void {
  const callbacks = useRef({ onUpdate, onConflict, onError, onSuccess });
  callbacks.current = { onUpdate, onConflict, onError, onSuccess };

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
          if (isTimelineChanged(reason)) {
            callbacks.current.onConflict();
            return;
          }
          const retryable = !(reason instanceof ApiClientError) ||
            reason.status === 429 || reason.status >= 500;
          callbacks.current.onError(reason, !retryable);
          if (!retryable) return;
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, jitter(retryMs));
            cancelDelay = () => {
              window.clearTimeout(timer);
              resolve();
            };
          });
          cancelDelay = null;
          retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
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

function jitter(milliseconds: number): number {
  return Math.round(milliseconds * (1 - RETRY_JITTER + Math.random() * RETRY_JITTER * 2));
}
