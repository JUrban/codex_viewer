import { useCallback, useEffect, useRef, useState } from "react";
import type {
  InteractionKey,
  TerminalPreviewResponse,
} from "../../shared/api-contract";
import { api } from "../api/client";
import { messageFor } from "./request-errors";

export function useSessionInteraction(sessionId: string, previewAvailable: boolean) {
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeSessionId = useRef(sessionId);
  const generation = useRef(0);
  const [preview, setPreview] = useState<TerminalPreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRequest = useRef<AbortController | null>(null);

  const cancelPreviewTerminal = useCallback(() => {
    const controller = previewRequest.current;
    if (controller === null) return;
    previewRequest.current = null;
    controller.abort();
    setPreviewBusy(false);
  }, []);

  if (activeSessionId.current !== sessionId) {
    activeSessionId.current = sessionId;
    generation.current += 1;
  }

  useEffect(() => {
    setError(null);
    setInteractionBusy(false);
    setPreview(null);
    setPreviewError(null);
    setPreviewBusy(false);
    cancelPreviewTerminal();
  }, [cancelPreviewTerminal, sessionId]);

  useEffect(() => {
    if (previewAvailable) return;
    cancelPreviewTerminal();
    setPreview(null);
    setPreviewError(null);
    setPreviewBusy(false);
  }, [cancelPreviewTerminal, previewAvailable]);

  const act = useCallback(async (operation: () => Promise<void>) => {
    const operationGeneration = ++generation.current;
    setInteractionBusy(true);
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
        setInteractionBusy(false);
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
      if (previewRequest.current === controller) {
        setPreview((current) => samePreviewContent(current, result) ? current : result);
      }
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

  useEffect(() => () => cancelPreviewTerminal(), [cancelPreviewTerminal]);

  return {
    interactionBusy,
    error,
    clearError: () => setError(null),
    sendMessage: (message: string) => act(() => api.sendMessage(sessionId, message)),
    sendKeys: (keys: readonly InteractionKey[]) => act(() => api.sendKeys(sessionId, keys)),
    preview,
    previewBusy,
    previewError,
    previewTerminal,
    cancelPreviewTerminal,
    clearPreviewError: () => setPreviewError(null),
  };
}

function samePreviewContent(
  current: TerminalPreviewResponse | null,
  next: TerminalPreviewResponse,
): boolean {
  return current !== null && current.content === next.content &&
    current.truncated === next.truncated;
}
