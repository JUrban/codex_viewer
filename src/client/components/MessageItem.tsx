import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessageItem as Message } from "../../shared/domain";

export function safeUrlTransform(url: string): string {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? defaultUrlTransform(url) : "";
  } catch {
    return "";
  }
}

export function MessageItem({ item }: { item: Message }) {
  const label = messageLabel(item);
  return <article className="message-body">
    <p className="event-label">{label} · {item.ordinal}</p>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrlTransform}
      components={{
        a: ({ href, children }) => href
          ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          : <span>{children}</span>,
        img: ({ alt }) => <span className="image-placeholder">[Image omitted{alt ? `: ${alt}` : ""}]</span>,
      }}>{item.markdown}</ReactMarkdown>
  </article>;
}

function messageLabel(item: Message): string {
  if (item.role === "user") return "User";
  return item.phase === "commentary" ? "Assistant commentary" : "Assistant final";
}
