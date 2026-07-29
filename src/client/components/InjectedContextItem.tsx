import { useCallback, useState } from "react";
import type { InjectedContextDetailResponse } from "../../shared/api-contract";
import type { InjectedContextItem as InjectedContext } from "../../shared/domain";
import { api } from "../api/client";
import { useLazyDetail } from "../state/use-lazy-detail";

interface InjectedContextItemProps {
  item: InjectedContext;
  sessionId: string;
  generation: number;
  onStale: () => void;
}

export function InjectedContextItem({
  item,
  sessionId,
  generation,
  onStale,
}: InjectedContextItemProps) {
  const [open, setOpen] = useState(false);
  const loadDetail = useCallback(
    (signal: AbortSignal): Promise<InjectedContextDetailResponse> =>
      api.context(sessionId, item.id, generation, signal),
    [generation, item.id, sessionId],
  );
  const { detail, error } = useLazyDetail({
    enabled: open,
    generation,
    load: loadDetail,
    unavailableMessage: "Injected context unavailable",
    onStale,
  });

  return (
    <article className="injected-context-body">
      <p className="event-label">Injected context · {item.ordinal}</p>
      <p><strong>{item.summary}</strong> · {item.charCount.toLocaleString()} characters</p>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide injected context" : "Show injected context"}
      </button>
      {open
        ? (
            <div className="tool-detail">
              {detail === null && error === null
                ? <p role="status">Loading injected context…</p>
                : null}
              {error ? <p role="alert">{error}</p> : null}
              {detail
                ? (
                    <>
                      <pre>{detail.text}</pre>
                      {detail.truncated || item.truncated
                        ? <p className="truncated">Injected context was truncated for safe display.</p>
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
