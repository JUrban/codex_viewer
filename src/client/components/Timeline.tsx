import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { ItemPagePosition, TimelineCursor } from "../../shared/api-contract";
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
import { EventMark } from "./EventMark";
import { InfiniteScrollSentinel } from "./InfiniteScrollSentinel";

interface TimelineProps {
  items: TimelineItem[];
  sessionId: string;
  cursor: TimelineCursor;
  previousCursor?: TimelineCursor | null;
  hasMore: boolean;
  loading: boolean;
  readerBusy?: boolean;
  forwardPaginationEnabled?: boolean;
  paginationFrozen?: boolean;
  initialPosition?: ItemPagePosition | null;
  onLoadMore: () => void | Promise<boolean>;
  onLoadPrevious?: () => void | Promise<boolean>;
  onTimelineConflict: () => void;
}

export const Timeline = memo(function Timeline({
  items,
  sessionId,
  cursor,
  previousCursor = null,
  hasMore,
  loading,
  readerBusy = loading,
  forwardPaginationEnabled = true,
  paginationFrozen = false,
  initialPosition = null,
  onLoadMore,
  onLoadPrevious = () => undefined,
  onTimelineConflict,
}: TimelineProps) {
  const entries = useMemo(() => projectUserInputCards(items), [items]);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (initialPosition !== "latest") return;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "auto",
    });
  }, [initialPosition, sessionId]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor === null) return;
    prependAnchor.current = null;
    window.scrollTo({
      top: anchor.top + document.documentElement.scrollHeight - anchor.height,
      behavior: "auto",
    });
  }, [items[0]?.id]);

  const loadPrevious = () => {
    prependAnchor.current = {
      height: document.documentElement.scrollHeight,
      top: window.scrollY,
    };
    return onLoadPrevious();
  };

  return (
    <>
      {previousCursor !== null && !paginationFrozen
        ? <InfiniteScrollSentinel
            enabled={!readerBusy}
            edge="start"
            triggerKey={previousCursor}
            loading={loading}
            loadingLabel="Loading earlier events…"
            onLoadMore={loadPrevious}
          />
        : null}
      <ol className="timeline" aria-label="Session timeline">
        {entries.map((item) => (
          <li
            className={`trace-event ${classFor(item)}`}
            key={`${sessionId}:${item.id}`}
          >
            <EventMark item={item} />
            <TimelineContent
              item={item}
              sessionId={sessionId}
              cursor={cursor}
              onTimelineConflict={onTimelineConflict}
            />
          </li>
        ))}
      </ol>
      {hasMore && forwardPaginationEnabled && !paginationFrozen
        ? <InfiniteScrollSentinel
            enabled={!readerBusy}
            triggerKey={cursor}
            loading={loading}
            loadingLabel="Loading more events…"
            onLoadMore={onLoadMore}
          />
        : null}
    </>
  );
});

function TimelineContent({
  item,
  sessionId,
  cursor,
  onTimelineConflict,
}: Pick<TimelineProps, "sessionId" | "cursor" | "onTimelineConflict"> & {
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
          onTimelineConflict={onTimelineConflict}
        />
      );
    case "tool":
      return (
        <ToolItem
          item={item}
          sessionId={sessionId}
          cursor={cursor}
          onTimelineConflict={onTimelineConflict}
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
