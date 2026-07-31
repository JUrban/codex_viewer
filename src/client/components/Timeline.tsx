import type {
  SessionReadContext,
  SessionReadCursor,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { DirectiveItem } from "./DirectiveItem";
import { InternalEventItem } from "./InternalEventItem";
import { MessageItem } from "./MessageItem";
import { TokenItem } from "./TokenItem";
import { ToolItem } from "./ToolItem";
import { TraceGutter } from "./TraceGutter";

interface TimelineProps {
  items: TimelineItem[];
  sessionId: string;
  cursor: SessionReadCursor;
  hasMore: boolean;
  loading: boolean;
  busy?: boolean;
  paginationFrozen?: boolean;
  onLoadMore: () => void;
  onContext: (expected: SessionReadCursor, context: SessionReadContext) => void;
  onConflict: () => void;
}

export function Timeline({
  items,
  sessionId,
  cursor,
  hasMore,
  loading,
  busy = loading,
  paginationFrozen = false,
  onLoadMore,
  onContext,
  onConflict,
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
              cursor={cursor}
              onContext={onContext}
              onConflict={onConflict}
            />
          </li>
        ))}
      </ol>
      {hasMore
        ? (
            <button
              className="load-more"
              type="button"
              disabled={busy || paginationFrozen}
              onClick={onLoadMore}
            >
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
  cursor,
  onContext,
  onConflict,
}: Pick<TimelineProps, "sessionId" | "cursor" | "onContext" | "onConflict"> & {
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
          cursor={cursor}
          onContext={onContext}
          onConflict={onConflict}
        />
      );
    case "tool":
      return (
        <ToolItem
          item={item}
          sessionId={sessionId}
          cursor={cursor}
          onContext={onContext}
          onConflict={onConflict}
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
