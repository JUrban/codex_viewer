import type { TimelineItem } from "../../shared/domain";

export function TraceGutter({ item }: { item: TimelineItem }) {
  return <span className="trace-mark" aria-hidden="true" data-kind={item.kind} />;
}
