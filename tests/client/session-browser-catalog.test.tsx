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
  NEXT_SESSION_REVISION,
  readContext,
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

describe("session catalog interactions", () => {
  it("keeps the selected session in the URL and opens its timeline", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sessions?")) return Promise.resolve(json(listBody));
      if (url.includes(`/${SESSION_ID}`) && !url.includes("/items")) {
        return Promise.resolve(json(detailBody));
      }
      return Promise.resolve(json(firstPage));
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(window.location.search).toContain(`session=${SESSION_ID}`);
    expect(await screen.findByText("original-session-id")).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Session timeline" })).toBeInTheDocument();
  });

  it("uses a storage-backed three-state archive scope and labels archived sessions", async () => {
    const listUrls: string[] = [];
    const archivedSession = {
      ...baseSession,
      archived: true,
      title: "Archived reader work",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/sessions?")) listUrls.push(url);
      if (url.includes(`/${SESSION_ID}`) && !url.includes("/items")) {
        return Promise.resolve(json({
          ...detailBody,
          context: {
            ...detailBody.context,
            session: { ...detailBody.context.session, ...archivedSession },
          },
        }));
      }
      if (url.includes("/items")) {
        return Promise.resolve(json({
          ...firstPage,
          context: {
            ...firstPage.context,
            session: {
              ...firstPage.context.session,
              ...archivedSession,
            },
          },
        }));
      }
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
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("codex-sessions-reader.filters.v1"))
      .toContain('"state":"archived"');
    expect(await screen.findByRole("button", { name: /Archived reader work.*Archived/ }))
      .toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "reader");
    expect(listUrls.some((url) => url.includes("q=reader"))).toBe(false);
    await user.keyboard("{Enter}");
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
    expect(window.location.search).not.toContain("archiveScope");

    window.history.replaceState(null, "", "/?archiveScope=archived");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(all).toBeChecked();
  });

  it("loads catalog pages beyond the first 200 summaries", async () => {
    const later = entry({ ...baseSession, id: CHILD_ID, title: "Later session" });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("offset=1")) return Promise.resolve(json({
        ...listBody,
        listRevision: listBody.listRevision,
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
      String(url).includes("offset=1") &&
      String(url).includes(`listRevision=${listBody.listRevision}`)
    )).toBe(true);
  });

  it("restarts once from the first page after a stale list revision", async () => {
    const replacement = entry({
      ...baseSession,
      id: CHILD_ID,
      title: "Replacement first page",
    });
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      listCalls += 1;
      if (url.includes("offset=1")) {
        return Promise.resolve(json({
          error: {
            code: "stale_list_revision",
            message: "The session list changed",
          },
        }, 409));
      }
      if (listCalls === 1) {
        return Promise.resolve(json({
          ...listBody,
          total: 2,
          nextOffset: 1,
          hasMore: true,
        }));
      }
      return Promise.resolve(json({
        ...listBody,
        listRevision: "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
        sessions: [replacement],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", {
      name: "Load more sessions (1 of 2)",
    }));
    expect(await screen.findByRole("button", {
      name: /Replacement first page/,
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reader work/ })).toBeNull();
    expect(listCalls).toBe(3);
  });

  it("replaces accumulated pages when a successful response has another revision", async () => {
    const replacement = entry({
      ...baseSession,
      id: CHILD_ID,
      title: "Different ordered result",
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("offset=1")) {
        return Promise.resolve(json({
          ...listBody,
          listRevision: "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
          sessions: [replacement],
        }));
      }
      return Promise.resolve(json({
        ...listBody,
        total: 2,
        nextOffset: 1,
        hasMore: true,
      }));
    }));
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", {
      name: "Load more sessions (1 of 2)",
    }));
    expect(await screen.findByRole("button", {
      name: /Different ordered result/,
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reader work/ })).toBeNull();
  });

  it("refreshes the catalog and selected timeline without clearing the current UI", async () => {
    let detailCalls = 0;
    let itemCalls = 0;
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) {
        itemCalls += 1;
        return Promise.resolve(json(firstPage));
      }
      if (url.includes(`/${SESSION_ID}`) && !url.includes("/items")) {
        detailCalls += 1;
        return Promise.resolve(json({
          context: detailCalls > 1
            ? readContext(NEXT_SESSION_REVISION, 2, true)
            : detailBody.context,
        }));
      }
      listCalls += 1;
      return Promise.resolve(json({
        ...listBody,
        listRevision: listCalls > 1
          ? "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm"
          : listBody.listRevision,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    expect(screen.getByRole("button", { name: /Reader work/ })).toBeInTheDocument();
    await waitFor(() => expect(detailCalls).toBe(2));
    expect(screen.queryByText(/Sessions refreshed/)).not.toBeInTheDocument();
    expect(listCalls).toBe(2);
    expect(itemCalls).toBe(1);
    expect(window.location.search).toContain(`session=${SESSION_ID}`);
  });

  it("replaces an in-flight page request when manually refreshing", async () => {
    let detailCalls = 0;
    let pageSignal: AbortSignal | undefined;
    const updatedTitle = "Reader work after refresh";
    vi.stubGlobal("fetch", vi.fn((
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/items") && url.includes("throughOrdinal=2")) {
        pageSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          pageSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(`/${SESSION_ID}`) && !url.includes("/items")) {
        detailCalls += 1;
        const context = detailCalls === 1
          ? detailBody.context
          : {
              ...readContext(NEXT_SESSION_REVISION, 2, true),
              session: { ...readContext().session, title: updatedTitle },
            };
        return Promise.resolve(json({ context }));
      }
      return Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more events" }));
    expect(pageSignal?.aborted).toBe(false);

    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));

    expect(await screen.findByRole("heading", { name: updatedTitle }))
      .toBeInTheDocument();
    expect(pageSignal?.aborted).toBe(true);
    expect(detailCalls).toBe(2);
  });

  it("preserves later pages and lazy detail across an unrelated catalog change", async () => {
    let listCalls = 0;
    let toolCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items/tool-2/tool")) {
        toolCalls += 1;
        return Promise.resolve(json({
          context: firstPage.context,
          sessionId: SESSION_ID,
          itemId: "tool-2",
          input: null,
          output: "Preserved tool detail",
          truncated: false,
        }));
      }
      if (url.includes("throughOrdinal=3")) {
        return Promise.resolve(json({
          ...firstPage,
          items: [{
            kind: "message",
            id: "message-4",
            ordinal: 4,
            timestamp: null,
            role: "assistant",
            phase: "final",
            markdown: "Still pageable",
          }],
          context: readContext(SESSION_REVISION, 4, false),
        }));
      }
      if (url.includes("throughOrdinal=2")) {
        return Promise.resolve(json({
          ...firstPage,
          items: [{
            kind: "message",
            id: "message-3",
            ordinal: 3,
            timestamp: null,
            role: "assistant",
            phase: "commentary",
            markdown: "Loaded before catalog refresh",
          }],
          context: readContext(SESSION_REVISION, 3, true),
        }));
      }
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(`/${SESSION_ID}`) && !url.includes("/items")) {
        return Promise.resolve(json({
          context: readContext(
            SESSION_REVISION,
            url.includes("throughOrdinal=3") ? 3 : 0,
            true,
          ),
        }));
      }
      listCalls += 1;
      return Promise.resolve(json({
        ...listBody,
        listRevision: listBody.listRevision,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    await user.click(screen.getByRole("checkbox", { name: "tool" }));
    await user.click(screen.getByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("Loaded before catalog refresh")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("Preserved tool detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh sessions" })).toBeEnabled()
    );
    expect(listCalls).toBe(2);
    expect(screen.getByText("Loaded before catalog refresh")).toBeInTheDocument();
    expect(screen.getByText("Preserved tool detail")).toBeInTheDocument();
    expect(toolCalls).toBe(1);
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
          context: { ...firstPage.context, hasMore: false },
        }));
      }
      if (url.includes(`/${SESSION_ID}`) && !url.includes("/items")) {
        return Promise.resolve(json(detailBody));
      }
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
  
    resolveRefresh(json({
      ...listBody,
      listRevision: "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
    }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh sessions" })).toBeEnabled()
    );
    expect(screen.queryByText(/Sessions refreshed/)).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.queryByText("Catalog unavailable")).toBeNull());
    expect(screen.queryByText(/Sessions refreshed/)).not.toBeInTheDocument();
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
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Could not load sessionsRefresh unavailable");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Refresh sessions" })).toBeDisabled();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh sessions" })).toBeEnabled());
    resolveRefresh(json({
      ...listBody,
      listRevision: "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
    }));
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
    await user.keyboard("{Enter}");
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
