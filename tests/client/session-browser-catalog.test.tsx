// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import {
  baseSession,
  CHILD_ID,
  detailBody,
  entry,
  firstPage,
  json,
  listBody,
  SESSION_ID,
} from "./session-browser.fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.history.replaceState(null, "", "/");
});

describe("session catalog interactions", () => {
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

  it("uses a URL-backed three-state archive scope and labels archived sessions", async () => {
    const listUrls: string[] = [];
    const archivedSession = {
      ...baseSession,
      archived: true,
      title: "Archived reader work",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/sessions?")) listUrls.push(url);
      if (url.endsWith(SESSION_ID)) {
        return Promise.resolve(json({
          ...detailBody,
          session: { ...detailBody.session, ...archivedSession },
        }));
      }
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      return Promise.resolve(json(
        url.includes("archiveScope=archived")
          ? {
              ...listBody,
              sessions: [entry(archivedSession)],
            }
          : listBody,
      ));
    }));
    const user = userEvent.setup();
    render(<App />);
    const active = await screen.findByRole("radio", { name: "Active" });
    const archived = screen.getByRole("radio", { name: "Archived" });
    const all = screen.getByRole("radio", { name: "All" });

    expect(active).toBeChecked();
    expect(all).not.toBeChecked();
    expect(listUrls.some((url) => url.includes("archiveScope=active"))).toBe(true);
    expect(window.location.search).toBe("");

    await user.click(archived);
    await waitFor(() => {
      expect(listUrls.some((url) => url.includes("archiveScope=archived"))).toBe(true);
    });
    expect(archived).toBeChecked();
    expect(window.location.search).toContain("archiveScope=archived");
    expect(await screen.findByRole("button", { name: /Archived reader work.*Archived/ }))
      .toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "reader");
    await waitFor(() => expect(window.location.search).toContain("q=reader"));
    await waitFor(() => {
      expect(listUrls.some((url) =>
        url.includes("archiveScope=archived") && url.includes("q=reader")
      )).toBe(true);
    });
    expect(archived).toBeChecked();

    await user.click(screen.getByRole("button", { name: /Archived reader work.*Archived/ }));
    expect(await screen.findByRole("heading", { name: "Archived reader work" }))
      .toBeInTheDocument();
    expect(screen.getAllByText("Archived")).toHaveLength(3);

    await user.click(all);
    expect(all).toBeChecked();
    expect(window.location.search).toContain("archiveScope=all");

    window.history.replaceState(null, "", "/?archiveScope=archived");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(archived).toBeChecked());
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
});
