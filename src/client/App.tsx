import { DiagnosticNotice } from "./components/DiagnosticNotice";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { SessionFilters } from "./components/SessionFilters";
import { SessionTree } from "./components/SessionTree";
import { useSessionFilters } from "./state/use-session-filters";
import { useSessionList } from "./state/use-session-list";

export function App() {
  const filterState = useSessionFilters();
  const catalog = useSessionList(filterState.filters);
  const sessions = catalog.list?.sessions ?? [];

  return (
    <main className="catalog-page">
      <aside className="session-index" aria-label="Session index">
        <header className="brand">
          <p className="eyebrow">Local trace notebook</p>
          <h1>Codex sessions</h1>
          <p>Private to this machine · local viewer</p>
        </header>
        <SessionFilters
          filters={filterState.filters}
          projects={catalog.list?.projects ?? []}
          onChange={filterState.setFilters}
        />
        {catalog.list?.warnings.length
          ? <DiagnosticNotice diagnostics={catalog.list.warnings} label="Search warnings" />
          : null}
        <div className="session-toolbar">
          <p className="section-label">Sessions · {catalog.list?.total ?? 0}</p>
          <button
            type="button"
            className="refresh-sessions"
            disabled={catalog.operation !== null}
            aria-label="Refresh sessions"
            onClick={() => void catalog.refresh()}
          >
            <span aria-hidden="true" className={`refresh-mark${catalog.refreshing ? " active" : ""}`}>↻</span>
            {catalog.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {catalog.listError
          ? <ErrorState title="Could not load sessions" message={catalog.listError} onDismiss={catalog.clearListError} />
          : null}
        {catalog.listLoading ? <p className="loading" role="status">Finding sessions…</p> : null}
        {!catalog.listLoading && catalog.list && sessions.length === 0
          ? (
              <EmptyState title={emptyTitle(filterState.filters.archiveScope)}>
                {emptyMessage(filterState.filters.archiveScope)}
              </EmptyState>
            )
          : <SessionTree entries={sessions} revealMatches={filterState.filters.q.length > 0} />}
        {catalog.list?.nextCursor
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
    </main>
  );
}

function emptyTitle(scope: "active" | "archived" | "all"): string {
  if (scope === "active") return "No active sessions match";
  if (scope === "archived") return "No archived sessions match";
  return "No sessions match";
}

function emptyMessage(scope: "active" | "archived" | "all"): string {
  return scope === "all"
    ? "Clear a filter or search for a different phrase."
    : "Try All sessions, or clear another filter.";
}
