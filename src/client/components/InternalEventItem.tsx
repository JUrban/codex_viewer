import type { InternalEventItem as Internal } from "../../shared/domain";

export function InternalEventItem({ item }: { item: Internal }) {
  return (
    <article className="internal-event-body">
      <p className="event-label">Internal · {item.ordinal}</p>
      <p>
        <strong>{item.eventType}</strong>
        <> — {item.summary}</>
      </p>
    </article>
  );
}
