import { DiagnosticNotice } from "./components/DiagnosticNotice";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { SessionFilters } from "./components/SessionFilters";
import { SessionReader } from "./components/SessionReader";
import { SessionTree } from "./components/SessionTree";
import { useSessionBrowser } from "./state/use-session-browser";

export function App() {
  const browser = useSessionBrowser();

  return (
    <main className="app-shell">
      <SessionIndex browser={browser} />
      <Reader browser={browser} />
    </main>
  );
}

type SessionBrowser = ReturnType<typeof useSessionBrowser>;

function SessionIndex({ browser }: { browser: SessionBrowser }) {
  const sessions = browser.list?.sessions ?? [];

  return (
    <aside className="session-index" aria-label="Session index">
      <header className="brand">
        <p className="eyebrow">Local trace notebook</p>
        <h1>Codex sessions</h1>
        <p>Private to this machine · read only</p>
      </header>
      <SessionFilters
        filters={browser.filters}
        projects={browser.list?.projects ?? []}
        onChange={browser.setFilters}
      />
      {browser.list?.warnings.length
        ? <DiagnosticNotice diagnostics={browser.list.warnings} />
        : null}
      <div className="session-toolbar">
        <p className="section-label">Sessions · {browser.list?.total ?? 0}</p>
        <button
          type="button"
          className="refresh-sessions"
          disabled={browser.listLoading || browser.refreshing}
          aria-label="Refresh sessions"
          onClick={() => void browser.refreshSessions()}
        >
          <span
            aria-hidden="true"
            className={`refresh-mark${browser.refreshing ? " active" : ""}`}
          >
            ↻
          </span>
          {browser.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <RefreshFeedback error={browser.refreshError} message={browser.refreshMessage} />
      {browser.listError
        ? <ErrorState message={browser.listError} onDismiss={browser.clearListError} />
        : null}
      {browser.listLoading ? <p className="loading" role="status">Finding sessions…</p> : null}
      {!browser.listLoading && browser.list && sessions.length === 0
        ? (
            <EmptyState title="No sessions match">
              Clear a filter or search for a different phrase.
            </EmptyState>
          )
        : (
            <SessionTree
              entries={sessions}
              selectedId={browser.selectedId}
              revealMatches={browser.filters.q.trim().length > 0}
              onSelect={browser.selectSession}
            />
          )}
      {browser.list?.hasMore
        ? (
            <button
              className="load-more"
              type="button"
              disabled={browser.listLoading}
              onClick={() => void browser.loadMoreSessions()}
            >
              {browser.listLoading
                ? "Loading sessions…"
                : `Load more sessions (${sessions.length} of ${browser.list.total})`}
            </button>
          )
        : null}
      {browser.list?.partial
        ? <p className="partial-notice">Results are partial because the safe search budget was reached.</p>
        : null}
    </aside>
  );
}

function RefreshFeedback({
  error,
  message,
}: {
  error: string | null;
  message: string | null;
}) {
  let content = null;
  if (error) {
    content = <p className="refresh-error" role="alert">{error} Try refreshing again.</p>;
  } else if (message) {
    content = <p>{message}</p>;
  }

  return <div className="refresh-feedback" aria-live="polite">{content}</div>;
}

function Reader({ browser }: { browser: SessionBrowser }) {
  if (browser.readerError && !browser.detail) {
    return (
      <section className="reader">
        <ErrorState message={browser.readerError} onDismiss={browser.clearReaderError} />
      </section>
    );
  }

  if (browser.detail) {
    return (
      <SessionReader
        detail={browser.detail}
        page={browser.page}
        items={browser.items}
        internal={browser.internal}
        onInternalChange={browser.setInternal}
        loading={browser.readerLoading}
        onLoadMore={browser.loadMore}
        onStale={browser.restartSession}
        error={browser.readerError}
        onDismissError={browser.clearReaderError}
      />
    );
  }

  return (
    <section className="reader reader-welcome">
      {browser.readerLoading
        ? <p className="loading" role="status">Opening session…</p>
        : (
            <EmptyState title="Choose a session">
              Select a trace from the index to read its conversation.
            </EmptyState>
          )}
    </section>
  );
}
