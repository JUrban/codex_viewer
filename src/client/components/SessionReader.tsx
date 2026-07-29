import type { ItemPageResponse, SessionDetailResponse } from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { DiagnosticNotice } from "./DiagnosticNotice";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { SessionHeader } from "./SessionHeader";
import { Timeline } from "./Timeline";

interface SessionReaderProps {
  detail: SessionDetailResponse;
  page: ItemPageResponse | null;
  items: TimelineItem[];
  internal: boolean;
  onInternalChange: (value: boolean) => void;
  loading: boolean;
  onLoadMore: () => void;
  onStale: () => void;
  error?: string | null;
  onDismissError?: () => void;
}

export function SessionReader({
  detail,
  page,
  items,
  internal,
  onInternalChange,
  loading,
  onLoadMore,
  onStale,
  error,
  onDismissError,
}: SessionReaderProps) {
  return (
    <section className="reader" aria-labelledby="session-title">
      {error && onDismissError
        ? <ErrorState message={error} onDismiss={onDismissError} />
        : null}
      <SessionHeader
        session={detail.session}
        internal={internal}
        onInternalChange={onInternalChange}
      />
      <DiagnosticNotice diagnostics={page?.diagnostics ?? detail.session.diagnostics} />
      {items.length === 0 && !loading
        ? (
            <EmptyState title="This session has no visible events">
              Try showing internal events, or wait for the session to update.
            </EmptyState>
          )
        : (
            <Timeline
              items={items}
              sessionId={detail.session.id}
              generation={page?.generation ?? detail.generation}
              hasMore={page?.hasMore ?? false}
              loading={loading}
              onLoadMore={onLoadMore}
              onStale={onStale}
            />
          )}
    </section>
  );
}
