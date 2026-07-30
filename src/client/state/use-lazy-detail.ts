import { useEffect, useState } from "react";
import type { SessionRevision } from "../../shared/domain";
import { ApiClientError } from "../api/client";

interface LazyDetailOptions<T> {
  enabled: boolean;
  sessionRevision: SessionRevision;
  load: (signal: AbortSignal) => Promise<T>;
  unavailableMessage: string;
  onStale: () => void;
}

export function useLazyDetail<T>({
  enabled,
  sessionRevision,
  load,
  unavailableMessage,
  onStale,
}: LazyDetailOptions<T>) {
  const [detail, setDetail] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staleRevision, setStaleRevision] = useState<SessionRevision | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setStaleRevision(null);
  }, [sessionRevision]);

  useEffect(() => {
    if (!enabled || detail !== null || staleRevision === sessionRevision) return;

    const controller = new AbortController();
    void load(controller.signal)
      .then(setDetail)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;

        if (reason instanceof ApiClientError && reason.code === "stale_session_revision") {
          setError(null);
          setStaleRevision(sessionRevision);
          onStale();
          return;
        }

        setError(reason instanceof Error ? reason.message : unavailableMessage);
      });

    return () => controller.abort();
  }, [
    detail,
    enabled,
    sessionRevision,
    load,
    onStale,
    staleRevision,
    unavailableMessage,
  ]);

  return { detail, error };
}
