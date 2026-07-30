import type { SessionDetail } from "../../shared/domain";
import type {
  TimelineVisibility,
  TimelineVisibilityKey,
} from "../state/timeline-visibility";

interface SessionHeaderProps {
  session: SessionDetail;
  visibility: TimelineVisibility;
  onVisibilityChange: (key: TimelineVisibilityKey, visible: boolean) => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function SessionHeader({
  session,
  visibility,
  onVisibilityChange,
}: SessionHeaderProps) {
  const updatedAt = session.updatedAt
    ? DATE_FORMAT.format(new Date(session.updatedAt))
    : "Time unavailable";

  return (
    <header className="reader-header">
      <div>
        <div className="session-heading-flags">
          <p className="eyebrow">Session trace</p>
          {session.archived ? <span className="archive-label">Archived</span> : null}
        </div>
        <h2 id="session-title">{session.title}</h2>
        <p className="session-meta">
          {session.cwd ?? "Project unavailable"} · {updatedAt} · {session.itemCount} events
        </p>
        <p className="session-origin">
          {sessionOriginLabel(session.origin)}
        </p>
        <p className="session-source-id">
          Original session ID · <code>{session.sourceId ?? "Unavailable"}</code>
        </p>
        <div className="event-toggles" role="group" aria-label="Timeline event visibility">
          {VISIBILITY_TOGGLES.map(({ key, label }) => (
            <label className="check-row event-toggle" key={key}>
              <input
                type="checkbox"
                checked={visibility[key]}
                onChange={(event) => onVisibilityChange(key, event.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
    </header>
  );
}

const VISIBILITY_TOGGLES: Array<{
  key: TimelineVisibilityKey;
  label: string;
}> = [
  { key: "directive", label: "directive" },
  { key: "tools", label: "tool" },
  { key: "token", label: "token" },
  { key: "internal", label: "internal" },
];

function sessionOriginLabel(origin: SessionDetail["origin"]): string {
  let label = origin.agentName;
  if (origin.agentVersion !== null) label += ` ${origin.agentVersion}`;
  if (origin.formatVersion !== null) label += ` · format ${origin.formatVersion}`;
  return label;
}
