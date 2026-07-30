import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { MessageItem as Message } from "../../shared/domain";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeUrlTransform(url: string): string {
  try {
    const parsed = new URL(url);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? defaultUrlTransform(url) : "";
  } catch {
    return "";
  }
}

export function MessageItem({ item }: { item: Message }) {
  return (
    <article className="message-body">
      <p className="event-label">{messageLabel(item)} · {item.ordinal}</p>
      <MarkdownContent markdown={item.markdown} />
    </article>
  );
}

export function MarkdownContent({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      skipHtml
      urlTransform={safeUrlTransform}
      components={{
        a: ({ href, children }) => href
          ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          : <span>{children}</span>,
        img: ({ alt }) => (
          <span className="image-placeholder">
            [Image omitted{alt ? `: ${alt}` : ""}]
          </span>
        ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function messageLabel(item: Message): string {
  if (item.role === "user") return "User";
  if (item.phase === "commentary") return "Assistant commentary";
  if (item.phase === "final") return "Assistant final";
  return "Assistant";
}
