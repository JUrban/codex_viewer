import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { MessageItem as Message } from "../../shared/domain";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

type MarkdownNode = {
  type: string;
  value?: string;
  data?: {
    hProperties?: {
      className?: string[];
    };
  };
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: MarkdownNode[];
};

function remarkStandaloneDisplayMath() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);

    function visit(node: MarkdownNode): void {
      for (const child of node.children ?? []) {
        const math = child.type === "paragraph" && child.children?.length === 1
          ? child.children[0]
          : undefined;
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        const raw = start === undefined || end === undefined ? "" : source.slice(start, end);

        if (
          math?.type === "inlineMath"
          && /^\s{0,3}\$\$[^\n]*\$\$\s*$/.test(raw)
          && math.data?.hProperties
        ) {
          math.data.hProperties.className = ["language-math", "math-display"];
        }
        visit(child);
      }
    }

    visit(tree);
  };
}

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
      remarkPlugins={[remarkGfm, remarkMath, remarkStandaloneDisplayMath]}
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
