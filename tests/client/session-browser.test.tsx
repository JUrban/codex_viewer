// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { MessageItem, safeUrlTransform } from "../../src/client/components/MessageItem";
import { groupSessions } from "../../src/client/components/SessionTree";
import type { SessionListEntry } from "../../src/shared/api-contract";
import type { SessionSummary } from "../../src/shared/domain";

const SESSION_ID = "abcdefghijklmnopqrstuvwx";
const CHILD_ID = "zyxwvutsrqponmlkjihgfedc";
const baseSession: SessionSummary = {
  id: SESSION_ID, title: "Reader work", preview: "preview", cwd: "/project/reader",
  createdAt: "2026-07-28T10:00:00Z", updatedAt: "2026-07-28T11:00:00Z",
  archived: false, parentId: null, childIds: [], sourceState: "complete" as const,
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
  session: { ...baseSession, diagnostics: [], itemCount: 3 },
};
const firstPage = {
  generation: 1, sourceState: "complete", diagnostics: [],
  items: [
    { kind: "message", id: "message-1", ordinal: 1, timestamp: null, role: "user", phase: null, markdown: "Hello" },
    { kind: "tool", id: "tool-2", ordinal: 2, timestamp: null, toolName: "exec", status: "completed", preview: "inspect", truncated: false, hasDetail: true },
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
    expect(await screen.findByRole("list", { name: "Session timeline" })).toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("Finished")).toBeInTheDocument();
    expect(screen.getAllByText(/exec/)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("<unsafe stays text>")).toBeInTheDocument();
    expect(screen.queryByText("unsafe stays text", { selector: "em" })).not.toBeInTheDocument();
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

  it("reloads with internal view when the explicit toggle changes", async () => {
    const fetchMock = standardFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    const toggle = await screen.findByRole("checkbox", { name: "Show internal events" });
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("view=internal"))).toBe(true));
    expect(window.location.search).toContain("internal=true");
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

  it("does not schedule live polling while the page is hidden", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const live = { ...baseSession, sourceState: "live" as const };
    const fetchMock = standardFetch({
      ...detailBody, session: { ...live, diagnostics: [], itemCount: 2 },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    vi.useFakeTimers();
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(fetchMock.mock.calls).toHaveLength(count);
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
