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
      <aside className="session-index" aria-label="Session index">
        <header className="brand">
          <p className="eyebrow">Local trace notebook</p>
          <h1>Codex sessions</h1>
          <p>Private to this machine · read only</p>
        </header>
        <SessionFilters filters={browser.filters} projects={browser.list?.projects ?? []}
          onChange={browser.setFilters} />
        {browser.list?.warnings.length ? <DiagnosticNotice diagnostics={browser.list.warnings} /> : null}
        {browser.listLoading ? <p className="loading" role="status">Finding sessions…</p> : null}
        {!browser.listLoading && browser.list && !browser.list.sessions.length
          ? <EmptyState title="No sessions match">Clear a filter or search for a different phrase.</EmptyState>
          : <SessionTree entries={browser.list?.sessions ?? []} selectedId={browser.selectedId}
              onSelect={browser.selectSession} />}
        {browser.list?.hasMore ? <button className="load-more" type="button"
          disabled={browser.listLoading} onClick={() => void browser.loadMoreSessions()}>
          {browser.listLoading ? "Loading sessions…" : `Load more sessions (${browser.list.sessions.length} of ${browser.list.total})`}
        </button> : null}
        {browser.list?.partial ? <p className="partial-notice">Results are partial because the safe search budget was reached.</p> : null}
      </aside>

      {browser.error ? <section className="reader"><ErrorState message={browser.error} onDismiss={browser.clearError} /></section>
        : browser.detail
          ? <SessionReader detail={browser.detail} page={browser.page} items={browser.items}
              internal={browser.internal} onInternalChange={browser.setInternal}
              loading={browser.readerLoading} onLoadMore={browser.loadMore} onStale={browser.restartSession} />
          : <section className="reader reader-welcome">
              {browser.readerLoading
                ? <p className="loading" role="status">Opening session…</p>
                : <EmptyState title="Choose a session">Select a trace from the index to read its conversation.</EmptyState>}
            </section>}
    </main>
  );
}
