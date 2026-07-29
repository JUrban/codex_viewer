import type { SessionDetail } from "../../shared/domain";

interface SessionHeaderProps {
  session: SessionDetail;
  internal: boolean;
  onInternalChange: (value: boolean) => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function SessionHeader({ session, internal, onInternalChange }: SessionHeaderProps) {
  const updatedAt = session.updatedAt
    ? DATE_FORMAT.format(new Date(session.updatedAt))
    : "Time unavailable";

  return (
    <header className="reader-header">
      <div>
        <p className="eyebrow">Session trace</p>
        <h2 id="session-title">{session.title}</h2>
        <p className="session-meta">
          {session.cwd ?? "Project unavailable"} · {updatedAt} · {session.itemCount} events
        </p>
        <p className="session-source-id">
          Original session ID · <code>{session.sourceId ?? "Unavailable"}</code>
        </p>
        <label className="check-row internal-toggle">
          <input
            type="checkbox"
            checked={internal}
            onChange={(event) => onInternalChange(event.target.checked)}
          />
          Show internal events
        </label>
      </div>
      <span className={`state state-${session.sourceState}`}>
        <span aria-hidden="true">●</span> {session.sourceState}
      </span>
    </header>
  );
}
