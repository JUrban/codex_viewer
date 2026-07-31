import { useEffect, useState } from "react";
import type {
  SessionReadContext,
  SessionReadCursor,
} from "../../shared/api-contract";
import { ApiClientError } from "../api/client";

interface VersionedDetail {
  context: SessionReadContext;
}

interface LazyDetailOptions<T extends VersionedDetail> {
  enabled: boolean;
  cursor: SessionReadCursor;
  load: (signal: AbortSignal) => Promise<T>;
  unavailableMessage: string;
  onContext: (
    expected: SessionReadCursor,
    context: SessionReadContext,
  ) => void;
  onConflict: () => void;
}

export function useLazyDetail<T extends VersionedDetail>({
  enabled,
  cursor,
  load,
  unavailableMessage,
  onContext,
  onConflict,
}: LazyDetailOptions<T>) {
  const [detail, setDetail] = useState<T | null>(null);
  const [failure, setFailure] = useState<{
    kind: "conflict" | "request";
    revision: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (failure?.kind === "request") setFailure(null);
      return;
    }
    if (
      detail?.context.cursor.sessionRevision === cursor.sessionRevision ||
      failure?.revision === cursor.sessionRevision
    ) {
      return;
    }

    const requestedCursor = cursor;
    const controller = new AbortController();
    setFailure(null);
    void load(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setDetail(value);
        onContext(requestedCursor, value.context);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        if (
          reason instanceof ApiClientError &&
          reason.code === "stale_timeline_prefix"
        ) {
          setFailure({
            kind: "conflict",
            revision: requestedCursor.sessionRevision,
            message: unavailableMessage,
          });
          onConflict();
          return;
        }
        setFailure({
          kind: "request",
          revision: requestedCursor.sessionRevision,
          message: reason instanceof Error ? reason.message : unavailableMessage,
        });
      });

    return () => controller.abort();
  }, [
    cursor,
    detail,
    enabled,
    failure,
    load,
    onConflict,
    onContext,
    unavailableMessage,
  ]);

  return { detail, error: failure?.message ?? null };
}
