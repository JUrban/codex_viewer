import { useMemo } from "react";
import type {
  InteractionResponse,
  SessionReadContext,
  SessionReadCursor,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import {
  filterVisibleTimelineItems,
  type TimelineVisibility,
  type TimelineVisibilityKey,
} from "../state/timeline-visibility";
import { BackToTop } from "./BackToTop";
import { DiagnosticNotice } from "./DiagnosticNotice";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { SessionHeader } from "./SessionHeader";
import { Timeline } from "./Timeline";
import { InteractionPanel } from "./InteractionPanel";
import { useSessionInteraction } from "../state/use-session-interaction";

interface SessionReaderProps {
  context: SessionReadContext;
  items: TimelineItem[];
  interaction: InteractionResponse | null;
  visibility: TimelineVisibility;
  onVisibilityChange: (key: TimelineVisibilityKey, visible: boolean) => void;
  loading: boolean;
  busy: boolean;
  autoRefreshEnabled: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  refreshIntervalSeconds: number;
  onRefreshIntervalChange: (seconds: number) => void;
  onLoadMore: () => void;
  onContext: (expected: SessionReadCursor, context: SessionReadContext) => void;
  onConflict: () => void;
  prefixChanged: boolean;
  timelineGeneration: number;
  onRefreshLatest: () => Promise<unknown>;
  error?: string | null;
  onDismissError?: () => void;
}

export function SessionReader({
  context,
  items,
  interaction,
  visibility,
  onVisibilityChange,
  loading,
  busy,
  autoRefreshEnabled,
  onAutoRefreshChange,
  refreshIntervalSeconds,
  onRefreshIntervalChange,
  onLoadMore,
  onContext,
  onConflict,
  prefixChanged,
  timelineGeneration,
  onRefreshLatest,
  error,
  onDismissError,
}: SessionReaderProps) {
  const visibleItems = useMemo(
    () => filterVisibleTimelineItems(items, visibility),
    [items, visibility],
  );
  const hasMore = context.hasMore;
  const interactionController = useSessionInteraction(context.session.id);

  return (
    <section className="reader" aria-labelledby="session-title">
      <SessionHeader
        session={context.session}
        visibility={visibility}
        onVisibilityChange={onVisibilityChange}
        autoRefreshEnabled={autoRefreshEnabled}
        onAutoRefreshChange={onAutoRefreshChange}
        refreshIntervalSeconds={refreshIntervalSeconds}
        onRefreshIntervalChange={onRefreshIntervalChange}
      />
      <DiagnosticNotice
        diagnostics={context.session.diagnostics}
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
              key={timelineGeneration}
              items={visibleItems}
              sessionId={context.session.id}
              cursor={context.cursor}
              hasMore={hasMore}
              loading={loading}
              busy={busy}
              paginationFrozen={prefixChanged}
              onLoadMore={onLoadMore}
              onContext={onContext}
              onConflict={onConflict}
            />
          )
        : null}
      {autoRefreshEnabled && !context.session.archived
        ? (
            <InteractionPanel
              interaction={interaction}
              busy={interactionController.busy}
              error={interactionController.error}
              onDismissError={interactionController.clearError}
              onSendMessage={interactionController.sendMessage}
              onInterrupt={interactionController.interrupt}
              onEscape={interactionController.sendEscape}
            />
          )
        : null}
      {error && onDismissError
        ? (
            <ErrorState
              title="Could not load session"
              message={error}
              onDismiss={onDismissError}
            />
          )
        : null}
      {prefixChanged
        ? (
            <aside className="continuity-notice" role="alert">
              <div>
                <strong>Session 内容已变化</strong>
                <p>已保留当前阅读位置。刷新到最新版本会从第一页重新载入。</p>
              </div>
              <button type="button" disabled={busy} onClick={onRefreshLatest}>
                刷新到最新版本
              </button>
            </aside>
          )
        : null}
      <BackToTop />
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
