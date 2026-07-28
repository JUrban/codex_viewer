const sessions = [
  { title: "Design the local session reader", project: "~/project/codex_viewer", selected: true },
  { title: "Investigate rollout formats", project: "~/.codex/sessions", selected: false },
  { title: "Child trace · security review", project: "~/project/codex_viewer", selected: false },
];

const events = [
  { kind: "human", label: "User · 01", text: "Confirm the mixed architecture and preserve a read-only boundary." },
  { kind: "assistant", label: "Assistant commentary · 02", text: "I’ll establish the contracts and secure local process first." },
  { kind: "tool", label: "Tool · 03 · completed", text: "Repository inspection (detail stays collapsed)", action: true },
  { kind: "final", label: "Assistant final · 04", text: "The plan is ready for milestone implementation." },
] as const;

export function App() {
  return (
    <main className="app-shell">
      <aside className="session-index" aria-label="Session index">
        <header className="brand">
          <p className="eyebrow">Local trace notebook</p>
          <h1>Codex sessions</h1>
          <p>Private to this machine · read only</p>
        </header>
        <form className="filters" role="search">
          <label htmlFor="session-search">Find a session</label>
          <input id="session-search" type="search" placeholder="Title, project, or message" />
        </form>
        <nav aria-label="Fixture sessions">
          <p className="section-label">Recent</p>
          <ul className="session-list">
            {sessions.map((session) => (
              <li key={session.title}>
                <button className={session.selected ? "session selected" : "session"} type="button">
                  <span>{session.title}</span>
                  <small>{session.project}</small>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <section className="reader" aria-labelledby="session-title">
        <header className="reader-header">
          <div>
            <p className="eyebrow">Session fixture</p>
            <h2 id="session-title">Design the local session reader</h2>
            <p className="session-meta">~/project/codex_viewer · 28 Jul 2026 · 4 events</p>
          </div>
          <span className="state"><span aria-hidden="true">●</span> complete</span>
        </header>

        <ol className="timeline" aria-label="Session timeline">
          {events.map((event) => (
            <li className={`trace-event ${event.kind}`} key={event.label}>
              <span className="trace-mark" aria-hidden="true" />
              <article>
                <p className="event-label">{event.label}</p>
                <p>{event.text}</p>
                {"action" in event && event.action ? <button type="button">Show tool detail</button> : null}
              </article>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

