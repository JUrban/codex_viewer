import { useEffect, useState } from "react";
import type { InjectedContextDetailResponse } from "../../shared/api-contract";
import type { InjectedContextItem as InjectedContext } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";

export function InjectedContextItem({ item, sessionId, generation, onStale }: {
  item: InjectedContext;
  sessionId: string;
  generation: number;
  onStale: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<InjectedContextDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staleGeneration, setStaleGeneration] = useState<number | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setStaleGeneration(null);
  }, [generation]);

  useEffect(() => {
    if (!open || detail || staleGeneration === generation) return;
    const controller = new AbortController();
    void api.context(sessionId, item.id, generation, controller.signal)
      .then(setDetail)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiClientError && reason.code === "stale_generation") {
          setError(null);
          setStaleGeneration(generation);
          onStale();
          return;
        }
        setError(reason instanceof Error ? reason.message : "Injected context unavailable");
      });
    return () => controller.abort();
  }, [detail, generation, item.id, onStale, open, sessionId, staleGeneration]);

  return <article className="injected-context-body">
    <p className="event-label">Injected context · {item.ordinal}</p>
    <p><strong>{item.summary}</strong> · {item.charCount.toLocaleString()} characters</p>
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? "Hide injected context" : "Show injected context"}
    </button>
    {open ? <div className="tool-detail">
      {!detail && !error ? <p role="status">Loading injected context…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {detail ? <>
        <pre>{detail.text}</pre>
        {detail.truncated || item.truncated
          ? <p className="truncated">Injected context was truncated for safe display.</p>
          : null}
      </> : null}
    </div> : null}
  </article>;
}
