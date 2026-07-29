// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { DirectiveItem } from "../../src/client/components/DirectiveItem";
import { MessageItem, safeUrlTransform } from "../../src/client/components/MessageItem";
import { groupSessions, SessionTree } from "../../src/client/components/SessionTree";
import { Timeline } from "../../src/client/components/Timeline";
import { ToolItem } from "../../src/client/components/ToolItem";
import type { ItemPageResponse, SessionListEntry } from "../../src/shared/api-contract";
import type {
  DirectiveItem as Directive,
  SessionSummary,
  ToolItem as Tool,
} from "../../src/shared/domain";

const SESSION_ID = "abcdefghijklmnopqrstuvwx";
const CHILD_ID = "zyxwvutsrqponmlkjihgfedc";
const OTHER_ID = "otherabcdefghijklmnopqrs";
const baseSession: SessionSummary = {
  id: SESSION_ID, title: "Reader work", preview: "preview", cwd: "/project/reader",
  createdAt: "2026-07-28T10:00:00Z", updatedAt: "2026-07-28T11:00:00Z",
  archived: false, parentId: null, childIds: [], sourceState: "complete" as const,
  agent: null,
  messageCount: 2, toolCount: 1, warningCount: 0,
};
const listBody = {
  generation: 1,
  sessions: [{ session: baseSession, matches: [] }],
  projects: [{ project: "/project/reader", count: 1 }],
  total: 1, nextOffset: null, hasMore: false,
  partial: false, warnings: [],
};
const detailBody = {
  generation: 1,
  session: { ...baseSession, sourceId: "original-session-id", diagnostics: [], itemCount: 3 },
};
const toolItem: Tool = {
  kind: "tool", id: "tool-2", ordinal: 2, timestamp: null, toolName: "exec",
  status: "completed", preview: "inspect", truncated: false, hasDetail: true,
};
const directiveItem: Directive = {
  kind: "directive",
  id: "directive-4",
  ordinal: 4,
  timestamp: null,
  summary: "AGENTS.md instructions",
  charCount: 1_892,
  truncated: false,
  hasDetail: true,
};
const firstPage: ItemPageResponse = {
  generation: 1, sourceState: "complete", diagnostics: [],
  items: [
    { kind: "message", id: "message-1", ordinal: 1, timestamp: null, role: "user", phase: null, markdown: "Hello" },
    toolItem,
  ],
  nextAfterOrdinal: 2, hasMore: true,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.history.replaceState(null, "", "/");
});

describe("session browser", () => {
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
      generation={1}
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
      generation={1}
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
      generation={1}
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

  it("keeps filters and selection in the URL and cancels obsolete list requests", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sessions?")) {
        if (init?.signal) signals.push(init.signal);
        return Promise.resolve(json(listBody));
      }
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(firstPage));
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByRole("searchbox"), "reader");
    await waitFor(() => expect(window.location.search).toContain("q=reader"));
    await waitFor(() => expect(signals.length).toBeGreaterThan(1), { timeout: 1000 });
    expect(signals.some((signal) => signal.aborted)).toBe(true);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(window.location.search).toContain(`session=${SESSION_ID}`);
    expect(await screen.findByText("original-session-id")).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Session timeline" })).toBeInTheDocument();
  });

  it("keeps the archived-only filter out of the page URL while sending it to the list API", async () => {
    const listUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/sessions?")) listUrls.push(url);
      return Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);
    const archived = await screen.findByRole("checkbox", { name: "Archived only" });

    await user.click(archived);
    await waitFor(() => {
      expect(listUrls.some((url) => url.includes("archived=true"))).toBe(true);
    });
    expect(archived).toBeChecked();
    expect(window.location.search).toBe("");

    await user.type(screen.getByRole("searchbox"), "reader");
    await waitFor(() => expect(window.location.search).toContain("q=reader"));
    expect(window.location.search).not.toContain("archived");
    await waitFor(() => {
      expect(listUrls.some((url) =>
        url.includes("archived=true") && url.includes("q=reader")
      )).toBe(true);
    });
    expect(archived).toBeChecked();
  });

  it("loads later pages without duplicates and fetches tool text only on expansion", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items/tool-2/tool")) return Promise.resolve(json({
        generation: 1, sessionId: SESSION_ID, itemId: "tool-2",
        input: "<unsafe stays text>", output: "done", truncated: true,
      }));
      if (url.includes("afterOrdinal=2")) return Promise.resolve(json({
        ...firstPage, items: [
          firstPage.items[1],
          { kind: "message", id: "message-3", ordinal: 3, timestamp: null, role: "assistant", phase: "final", markdown: "Finished" },
        ], nextAfterOrdinal: null, hasMore: false,
      }));
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/tool-2/tool"))).toBe(false);
    expect(screen.queryByText(/exec/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "tool" }));
    expect(await screen.findByText(/exec/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("Finished")).toBeInTheDocument();
    expect(screen.getAllByText(/exec/)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("<unsafe stays text>")).toBeInTheDocument();
    expect(screen.queryByText("unsafe stays text", { selector: "em" })).not.toBeInTheDocument();
  });

  it("keeps load more available when the loaded range is fully filtered", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("afterOrdinal=2")) return Promise.resolve(json({
        ...firstPage,
        items: [{
          kind: "message",
          id: "message-3",
          ordinal: 3,
          timestamp: null,
          role: "assistant",
          phase: "final",
          markdown: "Visible on the next page",
        }],
        nextAfterOrdinal: null,
        hasMore: false,
      }));
      if (url.includes("/items")) return Promise.resolve(json({
        ...firstPage,
        items: [toolItem],
        nextAfterOrdinal: 2,
        hasMore: true,
      }));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText(
      "No visible events in the loaded range. Load more events or change a visibility filter.",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("Visible on the next page")).toBeInTheDocument();
  });

  it("ignores an obsolete timeline page after switching sessions", async () => {
    let resolveOldPage!: (response: Response) => void;
    const oldPage = new Promise<Response>((resolve) => {
      resolveOldPage = resolve;
    });
    const other = { ...baseSession, id: OTHER_ID, title: "Other session" };
    const otherDetail = {
      generation: 1,
      session: { ...other, diagnostics: [], itemCount: 1 },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(SESSION_ID) && url.includes("afterOrdinal=2")) return oldPage;
      if (url.includes(OTHER_ID) && url.includes("/items")) return Promise.resolve(json({
        ...firstPage,
        items: [{
          kind: "message", id: "message-1", ordinal: 1, timestamp: null,
          role: "assistant", phase: "final", markdown: "Other timeline",
        }],
        nextAfterOrdinal: null,
        hasMore: false,
      }));
      if (url.endsWith(OTHER_ID)) return Promise.resolve(json(otherDetail));
      if (url.includes(SESSION_ID) && url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json({
        ...listBody,
        sessions: [entry(baseSession), entry(other)],
        total: 2,
      }));
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    await user.click(screen.getByRole("button", { name: "Load more events" }));
    await user.click(screen.getByRole("button", { name: /Other session/ }));
    expect(await screen.findByText("Other timeline")).toBeInTheDocument();
    resolveOldPage(json({
      ...firstPage,
      items: [{
        kind: "message", id: "message-3", ordinal: 3, timestamp: null,
        role: "assistant", phase: "final", markdown: "Obsolete timeline",
      }],
      nextAfterOrdinal: null,
      hasMore: false,
    }));
    await waitFor(() => expect(screen.queryByText("Obsolete timeline")).toBeNull());
    expect(screen.getByText("Other timeline")).toBeInTheDocument();
  });

  it("isolates tool detail by session identity", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(json({
        generation: 1,
        sessionId: url.includes(OTHER_ID) ? OTHER_ID : SESSION_ID,
        itemId: "tool-2",
        input: null,
        output: url.includes(OTHER_ID) ? "Other tool detail" : "Reader tool detail",
        truncated: false,
      }));
    }));
    const props = {
      items: [toolItem],
      generation: 1,
      hasMore: false,
      loading: false,
      onLoadMore: vi.fn(),
      onStale: vi.fn(),
    };
    const { rerender } = render(<Timeline {...props} sessionId={SESSION_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("Reader tool detail")).toBeInTheDocument();
    rerender(<Timeline {...props} sessionId={OTHER_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("Other tool detail")).toBeInTheDocument();
    expect(screen.queryByText("Reader tool detail")).toBeNull();
  });

  it("waits for a new generation before retrying stale tool detail", async () => {
    const onStale = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("generation=1")) {
        return Promise.resolve(json({ error: { code: "stale_generation", message: "stale" } }, 409));
      }
      return Promise.resolve(json({
        generation: 2, sessionId: SESSION_ID, itemId: "tool-2",
        input: null, output: "Fresh tool detail", truncated: false,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <ToolItem item={toolItem} sessionId={SESSION_ID} generation={1} onStale={onStale} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    rerender(<ToolItem item={toolItem} sessionId={SESSION_ID} generation={1} onStale={onStale} />);
    await act(async () => Promise.resolve());
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("generation=1"))).toHaveLength(1);
    rerender(<ToolItem item={toolItem} sessionId={SESSION_ID} generation={2} onStale={onStale} />);
    expect(await screen.findByText("Fresh tool detail")).toBeInTheDocument();
  });

  it("loads directive lazily and isolates it by session", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(json({
        generation: 1,
        sessionId: url.includes(OTHER_ID) ? OTHER_ID : SESSION_ID,
        itemId: "directive-4",
        text: url.includes(OTHER_ID) ? "Other directive" : "Reader directive",
        truncated: false,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      items: [directiveItem],
      generation: 1,
      hasMore: false,
      loading: false,
      onLoadMore: vi.fn(),
      onStale: vi.fn(),
    };
    const { rerender } = render(<Timeline {...props} sessionId={SESSION_ID} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/AGENTS.md instructions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    expect(await screen.findByText("Reader directive")).toBeInTheDocument();
    rerender(<Timeline {...props} sessionId={OTHER_ID} />);
    expect(screen.queryByText("Reader directive")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    expect(await screen.findByText("Other directive")).toBeInTheDocument();
  });

  it("waits for a new generation before retrying stale directive", async () => {
    const onStale = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("generation=1")) {
        return Promise.resolve(json({ error: { code: "stale_generation", message: "stale" } }, 409));
      }
      return Promise.resolve(json({
        generation: 2,
        sessionId: SESSION_ID,
        itemId: "directive-4",
        text: "Fresh directive",
        truncated: true,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <DirectiveItem
        item={directiveItem}
        sessionId={SESSION_ID}
        generation={1}
        onStale={onStale}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    rerender(<DirectiveItem
      item={directiveItem}
      sessionId={SESSION_ID}
      generation={1}
      onStale={onStale}
    />);
    await act(async () => Promise.resolve());
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("generation=1"))).toHaveLength(1);
    rerender(<DirectiveItem
      item={directiveItem}
      sessionId={SESSION_ID}
      generation={2}
      onStale={onStale}
    />);
    expect(await screen.findByText("Fresh directive")).toBeInTheDocument();
    expect(screen.getByText("Directive was truncated for safe display.")).toBeInTheDocument();
  });

  it("loads catalog pages beyond the first 200 summaries", async () => {
    const later = entry({ ...baseSession, id: CHILD_ID, title: "Later session" });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("offset=1")) return Promise.resolve(json({
        ...listBody,
        generation: 1,
        sessions: [later],
        total: 2,
        nextOffset: null,
        hasMore: false,
      }));
      return Promise.resolve(json({
        ...listBody,
        total: 2,
        nextOffset: 1,
        hasMore: true,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Load more sessions (1 of 2)" }));
    expect(await screen.findByRole("button", { name: /Later session/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes("offset=1") && String(url).includes("generation=1"))).toBe(true);
  });

  it("refreshes the catalog and selected timeline without clearing the current UI", async () => {
    let detailCalls = 0;
    let itemCalls = 0;
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) {
        itemCalls += 1;
        return Promise.resolve(json({ ...firstPage, generation: detailCalls || 1 }));
      }
      if (url.endsWith(SESSION_ID)) {
        detailCalls += 1;
        return Promise.resolve(json({ ...detailBody, generation: detailCalls }));
      }
      listCalls += 1;
      return Promise.resolve(json({ ...listBody, generation: listCalls > 1 ? 2 : 1 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    expect(screen.getByRole("button", { name: /Reader work/ })).toBeInTheDocument();
    expect(await screen.findByText("Sessions refreshed · 1 available")).toBeInTheDocument();
    expect(listCalls).toBe(2);
    expect(detailCalls).toBe(2);
    expect(itemCalls).toBe(2);
    expect(window.location.search).toContain(`session=${SESSION_ID}`);
  });

  it("keeps client visibility when a refresh finishes after a filter change", async () => {
    let resolveRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) {
        return Promise.resolve(json({
          ...firstPage,
          items: [
            {
              kind: "message",
              id: "conversation-view",
              ordinal: 1,
              timestamp: null,
              role: "assistant",
              phase: "final",
              markdown: "Conversation view",
            },
            {
              kind: "internal",
              id: "internal-view",
              ordinal: 2,
              timestamp: null,
              eventType: "client_filter",
              summary: "Internal view",
            },
          ],
          nextAfterOrdinal: null,
          hasMore: false,
        }));
      }
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      listCalls += 1;
      return listCalls === 2 ? pendingRefresh : Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Conversation view")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    const toggle = screen.getByRole("checkbox", { name: "internal" });
    await user.click(toggle);
    expect(await screen.findByText(/Internal view/)).toBeInTheDocument();

    resolveRefresh(json({ ...listBody, generation: 2 }));
    expect(await screen.findByText("Sessions refreshed · 1 available")).toBeInTheDocument();
    expect(toggle).toBeChecked();
    expect(screen.getByText(/Internal view/)).toBeInTheDocument();
    expect(screen.getByText("Conversation view")).toBeInTheDocument();
  });

  it("clears an initial catalog error after a successful manual refresh", async () => {
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      listCalls += 1;
      if (listCalls === 1) {
        return Promise.resolve(json({
          error: { code: "internal_error", message: "Catalog unavailable" },
        }, 500));
      }
      return Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    expect(await screen.findByText("Sessions refreshed · 1 available")).toBeInTheDocument();
    expect(screen.queryByText("Catalog unavailable")).toBeNull();
    expect(screen.getByText("Choose a session")).toBeInTheDocument();
  });

  it("keeps the existing session list when a manual refresh fails", async () => {
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/sessions?")) {
        listCalls += 1;
      }
      if (listCalls > 1) {
        return Promise.resolve(json({
          error: { code: "internal_error", message: "Refresh unavailable" },
        }, 500));
      }
      return Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("button", { name: /Reader work/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Refresh unavailable Try refreshing again.",
    );
    expect(screen.getByRole("button", { name: /Reader work/ })).toBeInTheDocument();
  });

  it("replaces a missing session deep link instead of adding a history entry", async () => {
    window.history.replaceState(null, "", `/?session=${SESSION_ID}`);
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_ID)) {
        return Promise.resolve(json({
          error: { code: "session_not_found", message: "Session not found" },
        }, 404));
      }
      return Promise.resolve(json(listBody));
    }));

    render(<App />);
    expect(await screen.findByText("Choose a session")).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(pushState).not.toHaveBeenCalled();
    replaceState.mockRestore();
    pushState.mockRestore();
  });

  it("ends the manual refresh state when a filter supersedes it", async () => {
    let resolveRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/sessions?")) {
        listCalls += 1;
        if (listCalls === 2) return refresh;
      }
      return Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("button", { name: /Reader work/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    expect(screen.getByRole("button", { name: "Refresh sessions" })).toBeDisabled();
    await user.type(screen.getByRole("searchbox"), "new");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh sessions" })).toBeEnabled());
    resolveRefresh(json({ ...listBody, generation: 2 }));
  });

  it("does not merge an obsolete catalog page after filters change", async () => {
    let resolveOldPage!: (response: Response) => void;
    const oldPage = new Promise<Response>((resolve) => {
      resolveOldPage = resolve;
    });
    const later = entry({ ...baseSession, id: CHILD_ID, title: "Obsolete later session" });
    const filtered = entry({
      ...baseSession,
      id: "filteredabcdefghijklmnop",
      title: "Filtered session",
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("offset=1")) return oldPage;
      if (url.includes("q=new")) return Promise.resolve(json({
        ...listBody,
        sessions: [filtered],
      }));
      return Promise.resolve(json({
        ...listBody,
        total: 2,
        nextOffset: 1,
        hasMore: true,
      }));
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Load more sessions (1 of 2)" }));
    await user.type(screen.getByRole("searchbox"), "new");
    expect(await screen.findByRole("button", { name: /Filtered session/ })).toBeInTheDocument();
    resolveOldPage(json({
      ...listBody,
      sessions: [later],
      total: 2,
      nextOffset: null,
      hasMore: false,
    }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Obsolete later session/ })).toBeNull();
    });
  });

  it("restarts from the first page when a generation becomes stale", async () => {
    let detailCalls = 0;
    let itemCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) {
        itemCalls += 1;
        if (itemCalls === 1) return Promise.resolve(json({ error: { code: "stale_generation", message: "stale" } }, 409));
        return Promise.resolve(json({ ...firstPage, generation: 2, hasMore: false }));
      }
      if (url.endsWith(SESSION_ID)) {
        detailCalls += 1;
        return Promise.resolve(json({ ...detailBody, generation: detailCalls }));
      }
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(detailCalls).toBe(2);
    expect(itemCalls).toBe(2);
  });

  it("filters four technical event types locally and persists them in one show parameter", async () => {
    const allKindsPage: ItemPageResponse = {
      ...firstPage,
      items: [
        firstPage.items[0],
        directiveItem,
        toolItem,
        {
          kind: "internal",
          id: "internal-5",
          ordinal: 5,
          timestamp: null,
          eventType: "reasoning",
          summary: "Local reasoning summary",
        },
        {
          kind: "token",
          id: "token-7",
          ordinal: 7,
          timestamp: null,
          tokenUsage: { total: null, last: null },
        },
        {
          kind: "internal",
          id: "internal-6",
          ordinal: 6,
          timestamp: null,
          eventType: "local_filter",
          summary: "Local internal event",
        },
      ],
      nextAfterOrdinal: null,
      hasMore: false,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json(allKindsPage));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();

    const directiveToggle = await screen.findByRole("checkbox", { name: "directive" });
    const toolToggle = screen.getByRole("checkbox", { name: "tool" });
    const tokenToggle = screen.getByRole("checkbox", { name: "token" });
    const internalToggle = screen.getByRole("checkbox", { name: "internal" });
    const visibilityGroup = screen.getByRole("group", { name: "Timeline event visibility" });
    expect(within(visibilityGroup).getAllByRole("checkbox")).toEqual([
      directiveToggle,
      toolToggle,
      tokenToggle,
      internalToggle,
    ]);
    expect(directiveToggle).not.toBeChecked();
    expect(toolToggle).not.toBeChecked();
    expect(tokenToggle).not.toBeChecked();
    expect(internalToggle).not.toBeChecked();
    expect(screen.queryByText(/exec/)).toBeNull();
    expect(screen.queryByText("AGENTS.md instructions")).toBeNull();
    expect(screen.queryByText("Local reasoning summary")).toBeNull();
    expect(screen.queryByText(/Local internal event/)).toBeNull();
    expect(screen.queryByText("Token · 7")).toBeNull();

    const itemCalls = () => fetchMock.mock.calls.filter(
      ([url]) => String(url).includes(`/${SESSION_ID}/items`),
    );
    expect(itemCalls()).toHaveLength(1);
    expect(String(itemCalls()[0]![0])).toContain("limit=512");
    expect(String(itemCalls()[0]![0])).not.toContain("view=");
    expect(String(itemCalls()[0]![0])).not.toContain("includeTools=");

    fireEvent.click(directiveToggle);
    fireEvent.click(toolToggle);
    fireEvent.click(tokenToggle);
    fireEvent.click(internalToggle);
    expect(screen.getByText(/exec/)).toBeInTheDocument();
    expect(screen.getByText("AGENTS.md instructions")).toBeInTheDocument();
    expect(screen.getByText(/Local reasoning summary/)).toBeInTheDocument();
    expect(screen.getByText(/Local internal event/)).toBeInTheDocument();
    expect(screen.getByText("Token · 7")).toBeInTheDocument();
    expect(window.location.search).toContain(
      "show=directive,tool,token,internal",
    );
    expect(window.location.search).not.toMatch(
      /(?:tools|directive|reasoning|internal|token)=true/,
    );
    expect(directiveToggle).toBeChecked();
    expect(toolToggle).toBeChecked();
    expect(tokenToggle).toBeChecked();
    expect(internalToggle).toBeChecked();
    expect(itemCalls()).toHaveLength(1);

    window.history.pushState(
      null,
      "",
      `/?session=${SESSION_ID}&show=directive,token,reasoning,directive,unknown`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(toolToggle).not.toBeChecked());
    expect(directiveToggle).toBeChecked();
    expect(internalToggle).not.toBeChecked();
    expect(tokenToggle).toBeChecked();
    expect(screen.queryByText(/exec/)).toBeNull();
    expect(screen.getByText("AGENTS.md instructions")).toBeInTheDocument();
    expect(screen.queryByText("Local reasoning summary")).toBeNull();
    expect(screen.queryByText(/Local internal event/)).toBeNull();
    expect(screen.getByText("Token · 7")).toBeInTheDocument();
    expect(itemCalls()).toHaveLength(1);

    window.history.pushState(
      null,
      "",
      `/?session=${SESSION_ID}&tools=true&directive=true&reasoning=true&internal=true`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(directiveToggle).not.toBeChecked());
    expect(toolToggle).not.toBeChecked();
    expect(internalToggle).not.toBeChecked();
    expect(tokenToggle).not.toBeChecked();
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

  it("labels an assistant message with an unknown phase neutrally", () => {
    render(<MessageItem item={{
      kind: "message", id: "message-10", ordinal: 10, timestamp: null,
      role: "assistant", phase: null, markdown: "Unclassified",
    }} />);
    expect(screen.getByText("Assistant · 10")).toBeInTheDocument();
    expect(screen.queryByText(/Assistant final/)).toBeNull();
  });

  it("polls the selected session while visible", async () => {
    vi.useFakeTimers();
    const fetchMock = standardFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: /Reader work/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Hello")).toBeInTheDocument();
    const detailCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(SESSION_ID)).length;
    const before = detailCalls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(detailCalls()).toBeGreaterThan(before);
  });

  it("preserves loaded pages during a same-generation poll", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("afterOrdinal=2")) return Promise.resolve(json({
        ...firstPage,
        items: [{
          kind: "message", id: "message-3", ordinal: 3, timestamp: null,
          role: "assistant", phase: "final", markdown: "Later event",
        }],
        nextAfterOrdinal: null,
        hasMore: false,
      }));
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: /Reader work/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Later event")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(screen.getByText("Later event")).toBeInTheDocument();
  });

  it("does not revive a disposed session poll after navigation", async () => {
    vi.useFakeTimers();
    let resolvePoll!: (response: Response) => void;
    const pendingPoll = new Promise<Response>((resolve) => {
      resolvePoll = resolve;
    });
    let readerDetailCalls = 0;
    const other = { ...baseSession, id: OTHER_ID, title: "Other session" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_ID)) {
        readerDetailCalls += 1;
        return readerDetailCalls === 1 ? Promise.resolve(json(detailBody)) : pendingPoll;
      }
      if (url.includes(OTHER_ID) && url.includes("/items")) return Promise.resolve(json({
        ...firstPage,
        items: [{
          kind: "message", id: "message-1", ordinal: 1, timestamp: null,
          role: "assistant", phase: "final", markdown: "Other timeline",
        }],
        nextAfterOrdinal: null,
        hasMore: false,
      }));
      if (url.endsWith(OTHER_ID)) return Promise.resolve(json({
        generation: 1,
        session: { ...other, diagnostics: [], itemCount: 1 },
      }));
      if (url.includes(SESSION_ID) && url.includes("/items")) {
        return Promise.resolve(json({ ...firstPage, hasMore: false }));
      }
      return Promise.resolve(json({
        ...listBody,
        sessions: [entry(baseSession), entry(other)],
        total: 2,
      }));
    }));
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: /Reader work/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    await act(async () => Promise.resolve());
    expect(readerDetailCalls).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /Other session/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Other timeline")).toBeInTheDocument();
    resolvePoll(json(detailBody));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(readerDetailCalls).toBe(2);
    expect(screen.getByText("Other timeline")).toBeInTheDocument();
  });

  it("settles reader loading when navigation clears the selection", async () => {
    let resolveDetail!: (response: Response) => void;
    const pendingDetail = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_ID)) return pendingDetail;
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Opening session…")).toBeInTheDocument();
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText("Choose a session")).toBeInTheDocument();
    resolveDetail(json(detailBody));
  });

  it("does not orphan an active load when the selected session is clicked again", async () => {
    let resolveDetail!: (response: Response) => void;
    const pendingDetail = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_ID)) return pendingDetail;
      if (url.includes("/items")) return Promise.resolve(json({ ...firstPage, hasMore: false }));
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    const session = await screen.findByRole("button", { name: /Reader work/ });
    fireEvent.click(session);
    expect(await screen.findByText("Opening session…")).toBeInTheDocument();
    fireEvent.click(session);
    resolveDetail(json(detailBody));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
  });

  it("does not schedule session polling while the page is hidden", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const fetchMock = standardFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    vi.useFakeTimers();
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(fetchMock.mock.calls).toHaveLength(count);
  });

  it("keeps the reader usable when the independent session list request fails", async () => {
    window.history.replaceState(null, "", `/?session=${SESSION_ID}`);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/sessions?")) {
        return Promise.resolve(json({
          error: { code: "internal_error", message: "Catalog failed" },
        }, 500));
      }
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json({ ...firstPage, hasMore: false }));
    }));

    render(<App />);
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Catalog failed");
    expect(screen.getByRole("list", { name: "Session timeline" })).toBeInTheDocument();
  });

  it("keeps the successful list when opening the reader fails", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_ID)) {
        return Promise.resolve(json({
          error: { code: "internal_error", message: "Reader failed" },
        }, 500));
      }
      return Promise.resolve(json(listBody));
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reader failed");
    expect(screen.getByRole("button", { name: /Reader work/ })).toBeInTheDocument();
  });

  it("preserves the current reader content when a visible poll fails", async () => {
    vi.useFakeTimers();
    let detailCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_ID)) {
        detailCalls += 1;
        return detailCalls === 1
          ? Promise.resolve(json(detailBody))
          : Promise.resolve(json({
              error: { code: "internal_error", message: "Poll failed" },
            }, 500));
      }
      if (url.includes("/items")) {
        return Promise.resolve(json({ ...firstPage, hasMore: false }));
      }
      return Promise.resolve(json(listBody));
    }));

    render(<App />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: /Reader work/ }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Poll failed");
  });
});

function standardFetch(detail: unknown = detailBody) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/items")) return Promise.resolve(json({ ...firstPage, hasMore: false }));
    if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detail));
    return Promise.resolve(json(listBody));
  });
}

function entry(session: SessionSummary): SessionListEntry {
  return { session, matches: [] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
