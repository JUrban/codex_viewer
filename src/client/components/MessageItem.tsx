import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { MessageItem as Message } from "../../shared/domain";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];
const MARKDOWN_COMPONENTS = {
  a: ({ href, children }: React.ComponentProps<"a">) => href
    ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
    : <span>{children}</span>,
  img: ({ alt }: React.ComponentProps<"img">) => (
    <span className="image-placeholder">
      [Image omitted{alt ? `: ${alt}` : ""}]
    </span>
  ),
};

export function safeUrlTransform(url: string): string {
  try {
    const parsed = new URL(url);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? defaultUrlTransform(url) : "";
  } catch {
    return "";
  }
}

export const MessageItem = memo(function MessageItem({ item }: { item: Message }) {
  const itemType = item.itemType === null ? "" : ` · ${item.itemType}`;
  return (
    <article className="message-body">
      <p className="event-label">{messageLabel(item)}{itemType} · {item.ordinal}</p>
      <MarkdownContent markdown={item.markdown} />
    </article>
  );
});

export const MarkdownContent = memo(function MarkdownContent({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      skipHtml
      urlTransform={safeUrlTransform}
      components={MARKDOWN_COMPONENTS}
    >
      {markdown}
    </ReactMarkdown>
  );
});

function messageLabel(item: Message): string {
  if (item.role === "user") return "User";
  if (item.phase === "commentary") return "Assistant commentary";
  if (item.phase === "final") return "Assistant final";
  return "Assistant";
}
