import { useCallback, useState } from "react";
import type { DirectiveDetailResponse } from "../../shared/api-contract";
import type { DirectiveItem as Directive } from "../../shared/domain";
import { api } from "../api/client";
import { useLazyDetail } from "../state/use-lazy-detail";

interface DirectiveItemProps {
  item: Directive;
  sessionId: string;
  generation: number;
  onStale: () => void;
}

export function DirectiveItem({
  item,
  sessionId,
  generation,
  onStale,
}: DirectiveItemProps) {
  const [open, setOpen] = useState(false);
  const loadDetail = useCallback(
    (signal: AbortSignal): Promise<DirectiveDetailResponse> =>
      api.directive(sessionId, item.id, generation, signal),
    [generation, item.id, sessionId],
  );
  const { detail, error } = useLazyDetail({
    enabled: open,
    generation,
    load: loadDetail,
    unavailableMessage: "Directive unavailable",
    onStale,
  });

  return (
    <article className="directive-body">
      <p className="event-label">Directive · {item.ordinal}</p>
      <p><strong>{item.summary}</strong> · {item.charCount.toLocaleString()} characters</p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide directive" : "Show directive"}
      </button>
      {open
        ? (
            <div className="tool-detail">
              {detail === null && error === null
                ? <p role="status">Loading directive…</p>
                : null}
              {error ? <p role="alert">{error}</p> : null}
              {detail
                ? (
                    <>
                      <pre>{detail.text}</pre>
                      {detail.truncated || item.truncated
                        ? <p className="truncated">Directive was truncated for safe display.</p>
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
