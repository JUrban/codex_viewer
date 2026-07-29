import type { ReasoningItem as Reasoning } from "../../shared/domain";
import { MarkdownContent } from "./MessageItem";

export function ReasoningItem({ item }: { item: Reasoning }) {
  return <article className="reasoning-body">
    <p className="event-label">Reasoning summary · {item.ordinal}</p>
    <MarkdownContent markdown={item.summary} />
    {item.truncated
      ? <p className="truncated">Reasoning summary was truncated for safe display.</p>
      : null}
  </article>;
}
