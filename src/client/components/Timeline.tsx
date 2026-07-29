import type { TimelineItem } from "../../shared/domain";
import { InjectedContextItem } from "./InjectedContextItem";
import { InternalEventItem } from "./InternalEventItem";
import { MessageItem } from "./MessageItem";
import { ReasoningItem } from "./ReasoningItem";
import { ToolItem } from "./ToolItem";
import { TraceGutter } from "./TraceGutter";

export function Timeline({ items, sessionId, generation, hasMore, loading, onLoadMore, onStale }: {
  items: TimelineItem[];
  sessionId: string;
  generation: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onStale: () => void;
}) {
  return <>
    <ol className="timeline" aria-label="Session timeline">
      {items.map((item) => <li className={`trace-event ${classFor(item)}`} key={`${sessionId}:${item.id}`}>
        <TraceGutter item={item} />
        {item.kind === "message" ? <MessageItem item={item} /> : null}
        {item.kind === "tool" ? <ToolItem item={item} sessionId={sessionId} generation={generation} onStale={onStale} /> : null}
        {item.kind === "injected-context"
          ? <InjectedContextItem item={item} sessionId={sessionId} generation={generation} onStale={onStale} />
          : null}
        {item.kind === "internal" ? <InternalEventItem item={item} /> : null}
        {item.kind === "reasoning" ? <ReasoningItem item={item} /> : null}
      </li>)}
    </ol>
    {hasMore ? <button className="load-more" type="button" disabled={loading} onClick={onLoadMore}>
      {loading ? "Loading…" : "Load more events"}
    </button> : null}
  </>;
}

function classFor(item: TimelineItem): string {
  if (item.kind === "message") {
    if (item.role === "user") return "human";
    if (item.phase === "final") return "final";
    return "assistant";
  }
  return item.kind;
}
