import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalPreviewResponse } from "../../shared/api-contract";
import { api } from "../api/client";
import { messageFor } from "./request-errors";

export function useSessionInteraction(sessionId: string, previewAvailable: boolean) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeSessionId = useRef(sessionId);
  const generation = useRef(0);
  const [preview, setPreview] = useState<TerminalPreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef<AbortController | null>(null);

  if (activeSessionId.current !== sessionId) {
    activeSessionId.current = sessionId;
    generation.current += 1;
  }

  useEffect(() => {
    setError(null);
    setBusy(false);
    setPreview(null);
    setPreviewError(null);
    setPreviewBusy(false);
    previewRequest.current?.abort();
    previewRequest.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (previewAvailable) return;
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreview(null);
    setPreviewError(null);
    setPreviewBusy(false);
  }, [previewAvailable]);

  const act = useCallback(async (operation: () => Promise<void>) => {
    const operationGeneration = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      if (generation.current === operationGeneration) {
        setError(messageFor(reason));
      }
      throw reason;
    } finally {
      if (generation.current === operationGeneration) {
        setBusy(false);
      }
    }
  }, []);

  const previewTerminal = useCallback(async () => {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const result = await api.terminalPreview(sessionId, controller.signal);
      if (previewRequest.current === controller) setPreview(result);
    } catch (reason) {
      if (previewRequest.current === controller && !controller.signal.aborted) {
        setPreviewError(messageFor(reason));
      }
      throw reason;
    } finally {
      if (previewRequest.current === controller) {
        previewRequest.current = null;
        setPreviewBusy(false);
      }
    }
  }, [sessionId]);

  useEffect(() => () => previewRequest.current?.abort(), []);

  return {
    busy,
    error,
    clearError: () => setError(null),
    sendMessage: (message: string) => act(() => api.sendMessage(sessionId, message)),
    interrupt: () => act(() => api.interrupt(sessionId)),
    sendEscape: () => act(() => api.sendEscape(sessionId)),
    preview,
    previewBusy,
    previewError,
    previewTerminal,
    clearPreviewError: () => setPreviewError(null),
  };
}
