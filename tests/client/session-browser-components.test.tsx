// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageItem, safeUrlTransform } from "../../src/client/components/MessageItem";
import { SessionHeader } from "../../src/client/components/SessionHeader";
import { groupSessions, SessionTree } from "../../src/client/components/SessionTree";
import { Timeline } from "../../src/client/components/Timeline";
import { DEFAULT_TIMELINE_VISIBILITY } from "../../src/client/state/timeline-visibility";
import {
  baseSession,
  CHILD_ID,
  entry,
  SESSION_ID,
  SESSION_REVISION,
} from "./session-browser.fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.history.replaceState(null, "", "/");
});

describe("session browser components", () => {
  it("renders a reasoning summary as plain internal event text", () => {
    render(<Timeline
      items={[{
        kind: "internal",
        id: "internal-3",
        ordinal: 3,
        timestamp: null,
        eventType: "reasoning",
        summary: "Visible reasoning summary",
      }]}
      sessionId={SESSION_ID}
      sessionRevision={SESSION_REVISION}
      hasMore={false}
      loading={false}
      onLoadMore={vi.fn()}
      onStale={vi.fn()}
    />);
  
    expect(screen.getByText("Internal · 3")).toBeInTheDocument();
    expect(screen.getByText("reasoning", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(/Visible reasoning summary/)).toBeInTheDocument();
  });

  it("renders detailed total and last token usage in separate groups", () => {
    render(<Timeline
      items={[{
        kind: "token",
        id: "token-7",
        ordinal: 7,
        timestamp: null,
        tokenUsage: {
          total: {
            totalTokens: 12_345,
            inputTokens: 10_000,
            cachedInputTokens: 4_000,
            cacheWriteInputTokens: 500,
            outputTokens: 2_000,
            reasoningOutputTokens: 345,
          },
          last: {
            totalTokens: 678,
            inputTokens: 500,
            cachedInputTokens: 100,
            cacheWriteInputTokens: null,
            outputTokens: 150,
            reasoningOutputTokens: null,
          },
        },
      }]}
      sessionId={SESSION_ID}
      sessionRevision={SESSION_REVISION}
      hasMore={false}
      loading={false}
      onLoadMore={vi.fn()}
      onStale={vi.fn()}
    />);
  
    const total = screen.getByRole("region", { name: "Total token usage" });
    const last = screen.getByRole("region", { name: "Last token usage" });
    expect(within(total).getByText("12,345")).toBeInTheDocument();
    expect(within(total).getByText("4,000")).toBeInTheDocument();
    expect(within(total).getByText("500")).toBeInTheDocument();
    expect(within(last).getByText("678")).toBeInTheDocument();
    expect(within(last).getByText("150")).toBeInTheDocument();
    expect(within(last).queryByText("Cache write input")).toBeNull();
    expect(within(last).queryByText("Reasoning output")).toBeNull();
  });

  it("renders unavailable token usage groups without affecting ordinary internal events", () => {
    render(<Timeline
      items={[
        {
          kind: "token",
          id: "token-8",
          ordinal: 8,
          timestamp: null,
          tokenUsage: { total: null, last: null },
        },
        {
          kind: "internal",
          id: "internal-9",
          ordinal: 9,
          timestamp: null,
          eventType: "turn_context",
          summary: "Internal event: turn_context",
        },
      ]}
      sessionId={SESSION_ID}
      sessionRevision={SESSION_REVISION}
      hasMore={false}
      loading={false}
      onLoadMore={vi.fn()}
      onStale={vi.fn()}
    />);
  
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getByText("turn_context").closest("p"))
      .toHaveTextContent("turn_context — Internal event: turn_context");
  });

  it("groups children and preserves missing-parent sessions", () => {
    const child = entry({ ...baseSession, id: CHILD_ID, parentId: SESSION_ID, title: "Child" });
    const grandchild = entry({
      ...baseSession,
      id: "grandchildabcdefghijklmn",
      parentId: CHILD_ID,
      title: "Grandchild",
    });
    const orphan = entry({ ...baseSession, id: "orphanabcdefghijklmnopqr", parentId: "missingabcdefghijklmnop", title: "Orphan" });
    const groups = groupSessions([entry(baseSession), child, grandchild, orphan]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.children[0]?.root.session.title).toBe("Child");
    expect(groups[0]?.children[0]?.children[0]?.root.session.title).toBe("Grandchild");
    expect(groups[1]).toMatchObject({ orphan: true, root: { session: { title: "Orphan" } } });
  });

  it("shows normalized source metadata in the catalog and session detail", () => {
    const versioned = {
      ...baseSession,
      origin: {
        ...baseSession.origin,
        agentVersion: "1.2.3",
        formatVersion: "rollout-v1",
      },
    };
    const { unmount } = render(
      <SessionTree
        entries={[entry(versioned)]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Codex", { selector: ".source-label" })).toBeInTheDocument();
    unmount();

    render(
      <SessionHeader
        session={{
          ...versioned,
          sourceId: "native-session",
          diagnostics: [],
          itemCount: 0,
        }}
        visibility={DEFAULT_TIMELINE_VISIBILITY}
        onVisibilityChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Codex 1.2.3 · format rollout-v1")).toBeInTheDocument();
    expect(screen.getByText(/native-session/)).toBeInTheDocument();
  });

  it("collapses child sessions and presents structured agent task identity", async () => {
    const child = entry({
      ...baseSession,
      id: CHILD_ID,
      parentId: SESSION_ID,
      title: "Inspect the repository implementation",
      agent: { taskName: "repository_review", nickname: "Sagan", role: "reviewer" },
    });
    const entries = [entry({ ...baseSession, childIds: [CHILD_ID] }), child];
    const user = userEvent.setup();
    const { rerender } = render(
      <SessionTree entries={entries} selectedId={null} onSelect={vi.fn()} />,
    );
  
    expect(screen.queryByRole("button", { name: /repository_review/ })).toBeNull();
    const disclosure = screen.getByRole("button", { name: /Expand 1 child sessions/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
    expect(screen.getByRole("button", { name: /repository_review/ })).toHaveTextContent(
      "Inspect the repository implementation",
    );
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText("Sagan")).toBeInTheDocument();
  
    rerender(<SessionTree entries={[...entries]} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /repository_review/ })).toBeInTheDocument();
  });

  it("reveals selected descendants and search results through nested branches", () => {
    const child = entry({ ...baseSession, id: CHILD_ID, parentId: SESSION_ID, title: "Child" });
    const grandchild = entry({
      ...baseSession,
      id: "grandchildabcdefghijklmn",
      parentId: CHILD_ID,
      title: "Grandchild",
    });
    const entries = [entry(baseSession), child, grandchild];
    const { rerender } = render(
      <SessionTree entries={entries} selectedId={grandchild.session.id} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Grandchild/ })).toBeInTheDocument();
    rerender(
      <SessionTree entries={entries} selectedId={null} revealMatches onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Grandchild/ })).toBeInTheDocument();
  });

  it("renders Markdown without raw HTML, external images, or dangerous links", () => {
    render(<MessageItem item={{
      kind: "message", id: "message-9", ordinal: 9, timestamp: null, role: "assistant", phase: "final",
      markdown: "<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://tracker.invalid/a.png)\n\n[good](https://example.com)",
    }} />);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("[Image omitted: remote]")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "good" })).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(safeUrlTransform("data:text/html,boom")).toBe("");
    expect(safeUrlTransform("file:///tmp/secret")).toBe("");
  });

  it("renders single-line double-dollar math inline and multiline math as display", () => {
    render(<MessageItem item={{
      kind: "message", id: "message-math", ordinal: 10, timestamp: null,
      role: "assistant", phase: "final",
      markdown: "Inline $E = mc^2$.\n\n$$a^2 + b^2 = c^2$$\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$",
    }} />);

    expect(document.querySelector(".katex")).toBeInTheDocument();
    expect(document.querySelector(".katex-display .katex")).toBeInTheDocument();
    expect(document.querySelectorAll(".katex")).toHaveLength(3);
    expect(document.querySelectorAll(".katex-display .katex")).toHaveLength(1);
  });

  it("leaves math syntax in code untouched and keeps invalid math readable", () => {
    render(<MessageItem item={{
      kind: "message", id: "message-math-edge", ordinal: 11, timestamp: null,
      role: "assistant", phase: "final",
      markdown: "`$notMath$`\n\n```text\n$$not display math$$\n```\n\n$$\\frac{1}{$$",
    }} />);

    expect(screen.getByText("$notMath$")).toBeInTheDocument();
    expect(screen.getByText("$$not display math$$")).toBeInTheDocument();
    expect(document.querySelector("code .katex")).toBeNull();
    expect(document.querySelector(".katex-error")).toHaveTextContent("\\frac{1}{");
  });

  it("labels an assistant message with an unknown phase neutrally", () => {
    render(<MessageItem item={{
      kind: "message", id: "message-10", ordinal: 10, timestamp: null,
      role: "assistant", phase: null, markdown: "Unclassified",
    }} />);
    expect(screen.getByText("Assistant · 10")).toBeInTheDocument();
    expect(screen.queryByText(/Assistant final/)).toBeNull();
  });
});
