import type { TimelineItem } from "../../shared/domain";
import { DirectiveItem } from "./DirectiveItem";
import { InternalEventItem } from "./InternalEventItem";
import { MessageItem } from "./MessageItem";
import { ReasoningItem } from "./ReasoningItem";
import { ToolItem } from "./ToolItem";
import { TraceGutter } from "./TraceGutter";

interface TimelineProps {
  items: TimelineItem[];
  sessionId: string;
  generation: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onStale: () => void;
}

export function Timeline({
  items,
  sessionId,
  generation,
  hasMore,
  loading,
  onLoadMore,
  onStale,
}: TimelineProps) {
  return (
    <>
      <ol className="timeline" aria-label="Session timeline">
        {items.map((item) => (
          <li
            className={`trace-event ${classFor(item)}`}
            key={`${sessionId}:${item.id}`}
          >
            <TraceGutter item={item} />
            <TimelineContent
              item={item}
              sessionId={sessionId}
              generation={generation}
              onStale={onStale}
            />
          </li>
        ))}
      </ol>
      {hasMore
        ? (
            <button className="load-more" type="button" disabled={loading} onClick={onLoadMore}>
              {loading ? "Loading…" : "Load more events"}
            </button>
          )
        : null}
    </>
  );
}

function TimelineContent({
  item,
  sessionId,
  generation,
  onStale,
}: Pick<TimelineProps, "sessionId" | "generation" | "onStale"> & { item: TimelineItem }) {
  switch (item.kind) {
    case "message":
      return <MessageItem item={item} />;
    case "tool":
      return (
        <ToolItem
          item={item}
          sessionId={sessionId}
          generation={generation}
          onStale={onStale}
        />
      );
    case "directive":
      return (
        <DirectiveItem
          item={item}
          sessionId={sessionId}
          generation={generation}
          onStale={onStale}
        />
      );
    case "internal":
      return <InternalEventItem item={item} />;
    case "reasoning":
      return <ReasoningItem item={item} />;
  }
}

function classFor(item: TimelineItem): string {
  if (item.kind === "message") {
    if (item.role === "user") return "human";
    if (item.phase === "final") return "final";
    return "assistant";
  }
  return item.kind;
}
