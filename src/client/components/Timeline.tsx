import type { TimelineCursor } from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import type { UserInputItem as UserInputTimelineItem } from "../../shared/domain";
import { DirectiveItem } from "./DirectiveItem";
import { InternalEventItem } from "./InternalEventItem";
import { MessageItem } from "./MessageItem";
import { TokenItem } from "./TokenItem";
import { ToolItem } from "./ToolItem";
import {
  UserInputItem,
  type UserInputCardEntry,
} from "./UserInputItem";
import { TraceGutter } from "./TraceGutter";

interface TimelineProps {
  items: TimelineItem[];
  sessionId: string;
  cursor: TimelineCursor;
  hasMore: boolean;
  loading: boolean;
  busy?: boolean;
  paginationFrozen?: boolean;
  onLoadMore: () => void;
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
  onConflict,
}: TimelineProps) {
  const entries = projectUserInputCards(items);
  return (
    <>
      <ol className="timeline" aria-label="Session timeline">
        {entries.map((item) => (
          <li
            className={`trace-event ${classFor(item)}`}
            key={`${sessionId}:${item.id}`}
          >
            <TraceGutter item={item} />
            <TimelineContent
              item={item}
              sessionId={sessionId}
              cursor={cursor}
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
  onConflict,
}: Pick<TimelineProps, "sessionId" | "cursor" | "onConflict"> & {
  item: TimelineEntry;
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
          onConflict={onConflict}
        />
      );
    case "tool":
      return (
        <ToolItem
          item={item}
          sessionId={sessionId}
          cursor={cursor}
          onConflict={onConflict}
        />
      );
    case "user_input":
      return <UserInputItem entry={item} />;
    case "token":
      return <TokenItem item={item} />;
    case "internal":
      return <InternalEventItem item={item} />;
  }
}

function classFor(item: TimelineEntry): string {
  if (item.kind === "message") {
    if (item.role === "user") return "human";
    if (item.phase === "final") return "final";
    return "assistant";
  }
  return item.kind;
}

type TimelineEntry = Exclude<TimelineItem, UserInputTimelineItem> | UserInputCardEntry;

function projectUserInputCards(items: readonly TimelineItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const latestRequests = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "user_input") {
      entries.push(item);
      continue;
    }
    if (item.stage === "request") {
      latestRequests.set(item.callId, entries.length);
      entries.push({
        kind: "user_input",
        id: item.id,
        ordinal: item.ordinal,
        request: item,
        response: null,
      });
      continue;
    }
    const requestIndex = latestRequests.get(item.callId);
    const request = requestIndex === undefined ? undefined : entries[requestIndex];
    if (requestIndex !== undefined && request?.kind === "user_input") {
      entries[requestIndex] = { ...request, response: item };
    } else {
      entries.push({
        kind: "user_input",
        id: item.id,
        ordinal: item.ordinal,
        request: null,
        response: item,
      });
    }
  }
  return entries;
}
