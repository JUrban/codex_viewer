import { useEffect, useState } from "react";
import type { ToolDetailResponse } from "../../shared/api-contract";
import type { ToolItem as Tool } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";

export function ToolItem({ item, sessionId, generation, onStale }: {
  item: Tool;
  sessionId: string;
  generation: number;
  onStale: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ToolDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !item.hasDetail || detail) return;
    const controller = new AbortController();
    void api.tool(sessionId, item.id, generation, controller.signal)
      .then(setDetail)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiClientError && reason.code === "stale_generation") {
          setError(null);
          onStale();
          return;
        }
        setError(reason instanceof Error ? reason.message : "Tool detail unavailable");
      });
    return () => controller.abort();
  }, [detail, generation, item.hasDetail, item.id, onStale, open, sessionId]);

  return <article className="tool-body">
    <p className="event-label">Tool · {item.ordinal} · {item.status}</p>
    <p><strong>{item.toolName}</strong>{item.preview ? ` — ${item.preview}` : ""}</p>
    {item.hasDetail ? <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? "Hide tool detail" : "Show tool detail"}
    </button> : <p className="muted">No detail available.</p>}
    {open ? <div className="tool-detail">
      {!detail && !error ? <p role="status">Loading tool detail…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {detail ? <>
        {detail.input !== null ? <><h4>Input</h4><pre>{detail.input}</pre></> : null}
        {detail.output !== null ? <><h4>Output</h4><pre>{detail.output}</pre></> : null}
        {detail.truncated || item.truncated ? <p className="truncated">Detail was truncated for safe display.</p> : null}
      </> : null}
    </div> : null}
  </article>;
}
