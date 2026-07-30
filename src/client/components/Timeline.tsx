import type { SessionRevision, TimelineItem } from "../../shared/domain";
import { DirectiveItem } from "./DirectiveItem";
import { InternalEventItem } from "./InternalEventItem";
import { MessageItem } from "./MessageItem";
import { TokenItem } from "./TokenItem";
import { ToolItem } from "./ToolItem";
import { TraceGutter } from "./TraceGutter";

interface TimelineProps {
  items: TimelineItem[];
  sessionId: string;
  sessionRevision: SessionRevision;
  hasMore: boolean;
  loading: boolean;
  busy?: boolean;
  onLoadMore: () => void;
  onStale: () => void;
}

export function Timeline({
  items,
  sessionId,
  sessionRevision,
  hasMore,
  loading,
  busy = loading,
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
              sessionRevision={sessionRevision}
              onStale={onStale}
            />
          </li>
        ))}
      </ol>
      {hasMore
        ? (
            <button className="load-more" type="button" disabled={busy} onClick={onLoadMore}>
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
  sessionRevision,
  onStale,
}: Pick<TimelineProps, "sessionId" | "sessionRevision" | "onStale"> & {
  item: TimelineItem;
}) {
  switch (item.kind) {
    case "message":
      return <MessageItem item={item} />;
    case "directive":
      return (
        <DirectiveItem
          item={item}
          sessionId={sessionId}
          sessionRevision={sessionRevision}
          onStale={onStale}
        />
      );
    case "tool":
      return (
        <ToolItem
          item={item}
          sessionId={sessionId}
          sessionRevision={sessionRevision}
          onStale={onStale}
        />
      );
    case "token":
      return <TokenItem item={item} />;
    case "internal":
      return <InternalEventItem item={item} />;
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
