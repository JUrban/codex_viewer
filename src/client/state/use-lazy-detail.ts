import { useEffect, useState } from "react";
import { ApiClientError } from "../api/client";

interface LazyDetailOptions<T> {
  enabled: boolean;
  generation: number;
  load: (signal: AbortSignal) => Promise<T>;
  unavailableMessage: string;
  onStale: () => void;
}

export function useLazyDetail<T>({
  enabled,
  generation,
  load,
  unavailableMessage,
  onStale,
}: LazyDetailOptions<T>) {
  const [detail, setDetail] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staleGeneration, setStaleGeneration] = useState<number | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setStaleGeneration(null);
  }, [generation]);

  useEffect(() => {
    if (!enabled || detail !== null || staleGeneration === generation) return;

    const controller = new AbortController();
    void load(controller.signal)
      .then(setDetail)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;

        if (reason instanceof ApiClientError && reason.code === "stale_generation") {
          setError(null);
          setStaleGeneration(generation);
          onStale();
          return;
        }

        setError(reason instanceof Error ? reason.message : unavailableMessage);
      });

    return () => controller.abort();
  }, [
    detail,
    enabled,
    generation,
    load,
    onStale,
    staleGeneration,
    unavailableMessage,
  ]);

  return { detail, error };
}
