import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { messageFor } from "./request-errors";

export function useSessionInteraction(sessionId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeSessionId = useRef(sessionId);
  const generation = useRef(0);

  if (activeSessionId.current !== sessionId) {
    activeSessionId.current = sessionId;
    generation.current += 1;
  }

  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [sessionId]);

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

  return {
    busy,
    error,
    clearError: () => setError(null),
    sendMessage: (message: string) => act(() => api.sendMessage(sessionId, message)),
    interrupt: () => act(() => api.interrupt(sessionId)),
    sendEscape: () => act(() => api.sendEscape(sessionId)),
  };
}
