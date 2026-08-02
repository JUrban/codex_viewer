import { useEffect, useState } from "react";
import type { TimelineCursor } from "../../shared/api-contract";
import { ApiClientError } from "../api/client";

interface LazyDetailOptions<T> {
  enabled: boolean;
  cursor: TimelineCursor;
  load: (cursor: TimelineCursor, signal: AbortSignal) => Promise<T>;
  unavailableMessage: string;
  onConflict: () => void;
}

export function useLazyDetail<T>({
  enabled,
  cursor,
  load,
  unavailableMessage,
  onConflict,
}: LazyDetailOptions<T>) {
  const [detail, setDetail] = useState<T | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || detail !== null) return;
    const controller = new AbortController();
    setFailure(null);
    void load(cursor, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiClientError && reason.code === "timeline_changed") {
          setFailure(unavailableMessage);
          onConflict();
          return;
        }
        setFailure(reason instanceof Error ? reason.message : unavailableMessage);
      });
    return () => controller.abort();
  }, [detail, enabled, load, onConflict, unavailableMessage]);

  return { detail, error: failure };
}
