import type { TimelineItem } from "../../shared/domain";

export function EventMark({ item }: { item: Pick<TimelineItem, "kind"> }) {
  return <span className="trace-mark" aria-hidden="true" data-kind={item.kind} />;
}
