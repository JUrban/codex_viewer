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
      <SessionIndex
        filters={browser.filters}
        catalog={{
          list: browser.catalog.list,
          operation: browser.catalog.operation,
          listLoading: browser.catalog.listLoading,
          refreshing: browser.catalog.refreshing,
          listError: browser.catalog.listError,
          loadMoreSessions: browser.catalog.loadMoreSessions,
          clearListError: browser.catalog.clearListError,
        }}
        selectedId={browser.location.selectedId}
        onSelect={browser.location.selectSession}
        onRefresh={browser.refreshSessions}
      />
      <Reader
        visibility={browser.location.visibility}
        onVisibilityChange={browser.location.setVisibility}
        onClearSelection={() => browser.location.selectSession(null)}
        reader={browser.reader}
      />
    </main>
  );
}

type SessionBrowser = ReturnType<typeof useSessionBrowser>;

interface SessionIndexProps {
  filters: SessionBrowser["filters"];
  catalog: Pick<
    SessionBrowser["catalog"],
    | "list"
    | "operation"
    | "listLoading"
    | "refreshing"
    | "listError"
    | "loadMoreSessions"
    | "clearListError"
  >;
  selectedId: string | null;
  onSelect: (selectedId: string | null) => void;
  onRefresh: () => Promise<void>;
}

function SessionIndex({
  filters,
  catalog,
  selectedId,
  onSelect,
  onRefresh,
}: SessionIndexProps) {
  const sessions = catalog.list?.sessions ?? [];

  return (
    <aside className="session-index" aria-label="Session index">
      <header className="brand">
        <p className="eyebrow">Local trace notebook</p>
        <h1>Codex sessions</h1>
        <p>Private to this machine · read only</p>
      </header>
      <SessionFilters
        filters={filters.applied}
        projects={catalog.list?.projects ?? []}
        onChange={filters.set}
      />
      {catalog.list?.warnings.length
        ? (
            <DiagnosticNotice
              diagnostics={catalog.list.warnings}
              label="Search warnings"
            />
          )
        : null}
      <div className="session-toolbar">
        <p className="section-label">Sessions · {catalog.list?.total ?? 0}</p>
        <button
          type="button"
          className="refresh-sessions"
          disabled={catalog.operation !== null}
          aria-label="Refresh sessions"
          onClick={() => void onRefresh()}
        >
          <span
            aria-hidden="true"
            className={`refresh-mark${catalog.refreshing ? " active" : ""}`}
          >
            ↻
          </span>
          {catalog.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {catalog.listError
        ? (
            <ErrorState
              title="Could not load sessions"
              message={catalog.listError}
              onDismiss={catalog.clearListError}
            />
          )
        : null}
      {catalog.listLoading ? <p className="loading" role="status">Finding sessions…</p> : null}
      {!catalog.listLoading && catalog.list && sessions.length === 0
        ? (
            <EmptyState title={emptyTitle(filters.applied.archiveScope)}>
              {emptyMessage(filters.applied.archiveScope)}
            </EmptyState>
          )
        : (
            <SessionTree
              entries={sessions}
              selectedId={selectedId}
              revealMatches={filters.applied.q.length > 0}
              onSelect={onSelect}
            />
          )}
      {catalog.list?.hasMore
        ? (
            <button
              className="load-more"
              type="button"
              disabled={catalog.operation !== null}
              onClick={() => void catalog.loadMoreSessions()}
            >
              {catalog.operation === "page"
                ? "Loading sessions…"
                : `Load more sessions (${sessions.length} of ${catalog.list.total})`}
            </button>
          )
        : null}
      {catalog.list?.partial
        ? <p className="partial-notice">Results are partial because the safe search budget was reached.</p>
        : null}
    </aside>
  );
}

function emptyTitle(scope: SessionBrowser["filters"]["applied"]["archiveScope"]): string {
  if (scope === "active") return "No active sessions match";
  if (scope === "archived") return "No archived sessions match";
  return "No sessions match";
}

function emptyMessage(scope: SessionBrowser["filters"]["applied"]["archiveScope"]): string {
  if (scope === "active") return "Try All sessions, or clear another filter.";
  if (scope === "archived") return "Try All sessions, or clear another filter.";
  return "Clear a filter or search for a different phrase.";
}

function Reader({
  visibility,
  onVisibilityChange,
  onClearSelection,
  reader,
}: {
  visibility: SessionBrowser["location"]["visibility"];
  onVisibilityChange: SessionBrowser["location"]["setVisibility"];
  onClearSelection: () => void;
  reader: SessionBrowser["reader"];
}) {
  if (reader.readerError && !reader.detail) {
    return (
      <section className="reader">
        <ErrorState
          title="Could not load session"
          message={reader.readerError}
          onDismiss={() => {
            reader.clearReaderError();
            onClearSelection();
          }}
        />
      </section>
    );
  }

  if (reader.detail) {
    return (
      <SessionReader
        detail={reader.detail}
        page={reader.page}
        items={reader.items}
        visibility={visibility}
        onVisibilityChange={onVisibilityChange}
        loading={reader.readerLoading}
        busy={reader.operation !== null}
        autoRefreshEnabled={reader.autoRefreshEnabled}
        onAutoRefreshChange={reader.setAutoRefreshEnabled}
        refreshIntervalSeconds={reader.refreshIntervalSeconds}
        onRefreshIntervalChange={reader.setRefreshIntervalSeconds}
        onLoadMore={reader.loadMore}
        onStale={reader.restartSession}
        error={reader.readerError}
        onDismissError={reader.clearReaderError}
      />
    );
  }

  return (
    <section className="reader reader-welcome">
      {reader.readerLoading
        ? <p className="loading" role="status">Opening session…</p>
        : (
            <EmptyState title="Choose a session">
              Select a trace from the index to read its conversation.
            </EmptyState>
          )}
    </section>
  );
}
