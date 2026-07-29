import { useMemo } from "react";
import type { ItemPageResponse, SessionDetailResponse } from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import {
  isTimelineItemVisible,
  type TimelineVisibility,
  type TimelineVisibilityKey,
} from "../state/timeline-visibility";
import { DiagnosticNotice } from "./DiagnosticNotice";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { SessionHeader } from "./SessionHeader";
import { Timeline } from "./Timeline";

interface SessionReaderProps {
  detail: SessionDetailResponse;
  page: ItemPageResponse | null;
  items: TimelineItem[];
  visibility: TimelineVisibility;
  onVisibilityChange: (key: TimelineVisibilityKey, visible: boolean) => void;
  loading: boolean;
  busy: boolean;
  onLoadMore: () => void;
  onStale: () => void;
  error?: string | null;
  onDismissError?: () => void;
}

export function SessionReader({
  detail,
  page,
  items,
  visibility,
  onVisibilityChange,
  loading,
  busy,
  onLoadMore,
  onStale,
  error,
  onDismissError,
}: SessionReaderProps) {
  const visibleItems = useMemo(
    () => items.filter((item) => isTimelineItemVisible(item, visibility)),
    [items, visibility],
  );
  const hasMore = page?.hasMore ?? false;

  return (
    <section className="reader" aria-labelledby="session-title">
      {error && onDismissError
        ? (
            <ErrorState
              title="Could not load session"
              message={error}
              onDismiss={onDismissError}
            />
          )
        : null}
      <SessionHeader
        session={detail.session}
        visibility={visibility}
        onVisibilityChange={onVisibilityChange}
      />
      <DiagnosticNotice
        diagnostics={page?.diagnostics ?? detail.session.diagnostics}
        label="Session diagnostics"
      />
      {visibleItems.length === 0 && !loading
        ? (
            <EmptyState title="This session has no visible events">
              {emptyStateMessage(visibility, hasMore)}
            </EmptyState>
          )
        : null}
      {visibleItems.length > 0 || hasMore
        ? (
            <Timeline
              items={visibleItems}
              sessionId={detail.session.id}
              generation={page?.generation ?? detail.generation}
              hasMore={hasMore}
              loading={loading}
              busy={busy}
              onLoadMore={onLoadMore}
              onStale={onStale}
            />
          )
        : null}
    </section>
  );
}

function emptyStateMessage(visibility: TimelineVisibility, hasMore: boolean): string {
  if (hasMore) {
    return "No visible events in the loaded range. Load more events or change a visibility filter.";
  }
  if (Object.values(visibility).some((visible) => !visible)) {
    return "Try showing more event types, or wait for the session to update.";
  }
  return "Wait for the session to update.";
}
