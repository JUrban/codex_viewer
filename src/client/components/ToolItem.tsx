import { useCallback, useState } from "react";
import type { ToolDetailResponse } from "../../shared/api-contract";
import type {
  SessionRevision,
  ToolItem as Tool,
} from "../../shared/domain";
import { api } from "../api/client";
import { useLazyDetail } from "../state/use-lazy-detail";

interface ToolItemProps {
  item: Tool;
  sessionId: string;
  sessionRevision: SessionRevision;
  onStale: () => void;
}

export function ToolItem({ item, sessionId, sessionRevision, onStale }: ToolItemProps) {
  const [open, setOpen] = useState(false);
  const loadDetail = useCallback(
    (signal: AbortSignal): Promise<ToolDetailResponse> =>
      api.tool(sessionId, item.id, sessionRevision, signal),
    [item.id, sessionId, sessionRevision],
  );
  const { detail, error } = useLazyDetail({
    enabled: open && item.hasDetail,
    sessionRevision,
    load: loadDetail,
    unavailableMessage: "Tool detail unavailable",
    onStale,
  });

  return (
    <article className="tool-body">
      <p className="event-label">Tool · {item.ordinal} · {item.status}</p>
      <p><strong>{item.toolName}</strong>{item.preview ? ` — ${item.preview}` : ""}</p>
      {item.hasDetail
        ? (
            <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              {open ? "Hide tool detail" : "Show tool detail"}
            </button>
          )
        : <p className="muted">No detail available.</p>}
      {open
        ? (
            <div className="tool-detail">
              {detail === null && error === null ? <p role="status">Loading tool detail…</p> : null}
              {error ? <p role="alert">{error}</p> : null}
              {detail
                ? (
                    <>
                      {detail.input !== null ? <><h4>Input</h4><pre>{detail.input}</pre></> : null}
                      {detail.output !== null ? <><h4>Output</h4><pre>{detail.output}</pre></> : null}
                      {detail.truncated || item.truncated
                        ? <p className="truncated">Detail was truncated for safe display.</p>
                        : null}
                    </>
                  )
                : null}
            </div>
          )
        : null}
    </article>
  );
}
