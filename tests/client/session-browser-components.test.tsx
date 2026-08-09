// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageItem, safeUrlTransform } from "../../src/client/components/MessageItem";
import { SessionHeader } from "../../src/client/components/SessionHeader";
import { groupSessions, SessionTree } from "../../src/client/components/SessionTree";
import { Timeline } from "../../src/client/components/Timeline";
import { DEFAULT_TIMELINE_VISIBILITY } from "../../src/client/state/timeline-visibility";
import {
  baseSession,
  CHILD_ID,
  entry,
  firstPage,
  SESSION_ID,
} from "./session-browser.fixtures";

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
      cursor={firstPage.cursor}
      hasMore={false}
      loading={false}
      onLoadMore={vi.fn()}
      onTimelineConflict={vi.fn()}
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
      cursor={firstPage.cursor}
      hasMore={false}
      loading={false}
      onLoadMore={vi.fn()}
      onTimelineConflict={vi.fn()}
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

  it("renders unavailable token usage groups", () => {
    render(<Timeline
      items={[{
        kind: "token",
        id: "token-8",
        ordinal: 8,
        timestamp: null,
        tokenUsage: { total: null, last: null },
      }]}
      sessionId={SESSION_ID}
      cursor={firstPage.cursor}
      hasMore={false}
      loading={false}
      onLoadMore={vi.fn()}
      onTimelineConflict={vi.fn()}
    />);
  
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
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
    expect(groups[0]?.children[0]?.root.title).toBe("Child");
    expect(groups[0]?.children[0]?.children[0]?.root.title).toBe("Grandchild");
    expect(groups[1]).toMatchObject({ orphan: true, root: { title: "Orphan" } });
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
        autoRefreshEnabled={false}
        onAutoRefreshChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Codex 1.2.3 · format rollout-v1")).toBeInTheDocument();
    expect(screen.getByText(/native-session/)).toBeInTheDocument();
  });

  it("falls back when the session update timestamp is invalid", () => {
    render(
      <SessionHeader
        session={{
          ...baseSession,
          sourceId: "native-session",
          diagnostics: [],
          itemCount: 0,
          updatedAt: "not-a-timestamp",
        }}
        visibility={DEFAULT_TIMELINE_VISIBILITY}
        onVisibilityChange={vi.fn()}
        autoRefreshEnabled={false}
        onAutoRefreshChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/Time unavailable/)).toBeInTheDocument();
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
      <SessionTree entries={entries} />,
    );
  
    expect(screen.queryByRole("link", { name: /repository_review/ })).toBeNull();
    const disclosure = screen.getByRole("button", { name: /Expand 1 child sessions/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
    expect(screen.getByRole("link", { name: /repository_review/ })).toHaveTextContent(
      "Inspect the repository implementation",
    );
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.getByText("Sagan")).toBeInTheDocument();
  
    rerender(<SessionTree entries={[...entries]} />);
    expect(screen.getByRole("link", { name: /repository_review/ })).toBeInTheDocument();
  });

  it("renders Markdown without raw HTML, external images, or dangerous links", () => {
    render(<MessageItem item={{
      kind: "message", id: "message-9", ordinal: 9, timestamp: null, role: "assistant", phase: "final", itemType: null,
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
      role: "assistant", phase: "final", itemType: null,
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
      role: "assistant", phase: "final", itemType: null,
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
      role: "assistant", phase: null, itemType: null, markdown: "Unclassified",
    }} />);
    expect(screen.getByText("Assistant · 10")).toBeInTheDocument();
    expect(screen.queryByText(/Assistant final/)).toBeNull();
  });

  it("shows the completed item type in the message label", () => {
    render(<MessageItem item={{
      kind: "message", id: "message-plan", ordinal: 12, timestamp: null,
      role: "assistant", phase: "final", itemType: "Plan", markdown: "# Plan",
    }} />);
    expect(screen.getByText("Assistant final · Plan · 12")).toBeInTheDocument();
  });
});
