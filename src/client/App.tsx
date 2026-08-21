import { DiagnosticNotice } from "./components/DiagnosticNotice";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { SessionFilters } from "./components/SessionFilters";
import { SessionTree } from "./components/SessionTree";
import { InfiniteScrollSentinel } from "./components/InfiniteScrollSentinel";
import {
  useSessionFilters,
  type ArchiveScope,
} from "./state/use-session-filters";
import { useSessionList } from "./state/use-session-list";
import type { SessionSummary } from "../shared/domain";

export function App() {
  const filterState = useSessionFilters();
  const catalog = useSessionList(filterState.filters);
  const { archiveScope } = filterState.filters;
  const sessions = filterByArchiveScope(
    catalog.list?.sessions ?? [],
    archiveScope,
  );
  const displayedCount = archiveScope === "all"
    ? catalog.list?.total ?? 0
    : sessions.length;
  const exhausted = catalog.list?.nextCursor === null;

  return (
    <main className="catalog-page">
      <aside className="session-index" aria-label="Session index">
        <div className="catalog-header">
          <header className="brand">
            <p className="eyebrow">Local trace notebook</p>
            <h1>Codex sessions</h1>
            <p>Private to this machine · local viewer</p>
          </header>
          <div className="session-toolbar">
            <p className="section-label">Sessions · {displayedCount}</p>
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
        </div>
        <SessionFilters
          filters={filterState.filters}
          projects={catalog.list?.projects ?? []}
          onChange={filterState.setFilters}
        />
        <DiagnosticNotice
          diagnostics={catalog.list?.diagnostics ?? []}
          label="Catalog diagnostics"
        />
        {catalog.listError
          ? <ErrorState title="Could not load sessions" message={catalog.listError} onDismiss={catalog.clearListError} />
          : null}
        {catalog.listLoading ? <p className="loading" role="status">Finding sessions…</p> : null}
        {!catalog.listLoading && catalog.list && sessions.length === 0 && exhausted
          ? (
              <EmptyState title={emptyTitle(archiveScope)}>
                {emptyMessage(archiveScope)}
              </EmptyState>
            )
          : <SessionTree entries={sessions} />}
        {catalog.list?.nextCursor
          ? <InfiniteScrollSentinel
              enabled={catalog.operation === null}
              triggerKey={catalog.list.nextCursor}
              loading={catalog.operation === "page"}
              loadingLabel="Loading more sessions…"
              onLoadMore={() => void catalog.loadMoreSessions()}
            />
          : null}
      </aside>
    </main>
  );
}

function filterByArchiveScope(
  sessions: readonly SessionSummary[],
  scope: ArchiveScope,
): SessionSummary[] {
  if (scope === "all") return [...sessions];
  const archived = scope === "archived";
  return sessions.filter((session) => session.archived === archived);
}

function emptyTitle(scope: ArchiveScope): string {
  if (scope === "active") return "No active sessions match";
  if (scope === "archived") return "No archived sessions match";
  return "No sessions match";
}

function emptyMessage(scope: ArchiveScope): string {
  return scope === "all"
    ? "Clear a filter to see more sessions."
    : "Try All sessions, or clear another filter.";
}
