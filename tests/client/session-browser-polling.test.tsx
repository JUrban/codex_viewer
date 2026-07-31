// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import {
  baseSession,
  detailBody,
  entry,
  firstPage,
  json,
  listBody,
  NEXT_SESSION_REVISION,
  OTHER_ID,
  SESSION_ID,
  SESSION_REVISION,
  standardFetch,
} from "./session-browser.fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.history.replaceState(null, "", "/");
});

describe("session polling and failures", () => {
  it("keeps polling off by default and starts and stops it manually", async () => {
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
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(detailCalls()).toBe(before);

    const autoRefresh = screen.getByRole("switch", { name: "Live updates" });
    fireEvent.click(autoRefresh);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(detailCalls()).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(detailCalls()).toBe(before + 1);

    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Refresh interval in seconds" }),
      { target: { value: "3" } },
    );
    expect(window.localStorage.getItem("codex-sessions-reader.refresh-interval-seconds.v1"))
      .toBe("3");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(detailCalls()).toBe(before + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(detailCalls()).toBe(before + 2);

    fireEvent.click(autoRefresh);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(detailCalls()).toBe(before + 2);
  });

  it("restores a persisted refresh interval", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(
      "codex-sessions-reader.refresh-interval-seconds.v1",
      "15",
    );
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

    expect(screen.getByRole("spinbutton", { name: "Refresh interval in seconds" }))
      .toHaveValue(15);
    const detailCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith(SESSION_ID)).length;
    const before = detailCalls();
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(detailCalls()).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(detailCalls()).toBe(before + 1);
  });

  it.each(["0", "3601", "1.5", "not-a-number"])(
    "falls back to 5s for invalid persisted interval %s",
    async (storedInterval) => {
      vi.useFakeTimers();
      window.localStorage.setItem(
        "codex-sessions-reader.refresh-interval-seconds.v1",
        storedInterval,
      );
      vi.stubGlobal("fetch", standardFetch());
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole("button", { name: /Reader work/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByRole("spinbutton", { name: "Refresh interval in seconds" }))
        .toHaveValue(5);
    },
  );

  it("does not poll an archived session but keeps manual refresh available", async () => {
    vi.useFakeTimers();
    const archivedSession = { ...baseSession, archived: true };
    const archivedDetail = {
      ...detailBody,
      session: { ...detailBody.session, archived: true },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json({ ...firstPage, hasMore: false }));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(archivedDetail));
      return Promise.resolve(json({
        ...listBody,
        sessions: [entry(archivedSession)],
      }));
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
    expect(screen.queryByRole("switch", { name: "Live updates" }))
      .toBeNull();
    const detailCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith(SESSION_ID)).length;
    const before = detailCalls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(detailCalls()).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(detailCalls()).toBe(before + 1);
  });

  it("preserves loaded pages during a same-revision poll", async () => {
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
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Later event")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText("Later event")).toBeInTheDocument();
  });

  it("restarts loaded pages when the selected session revision changes", async () => {
    vi.useFakeTimers();
    let detailCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("afterOrdinal=2")) {
        return Promise.resolve(json({
          ...firstPage,
          items: [{
            kind: "message",
            id: "message-3",
            ordinal: 3,
            timestamp: null,
            role: "assistant",
            phase: "final",
            markdown: "Old later event",
          }],
          nextAfterOrdinal: null,
          hasMore: false,
        }));
      }
      if (url.includes(`sessionRevision=${NEXT_SESSION_REVISION}`)) {
        return Promise.resolve(json({
          ...firstPage,
          sessionRevision: NEXT_SESSION_REVISION,
          items: [{
            kind: "message",
            id: "message-1",
            ordinal: 1,
            timestamp: null,
            role: "user",
            phase: null,
            markdown: "Fresh session start",
          }],
          nextAfterOrdinal: null,
          hasMore: false,
        }));
      }
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.endsWith(SESSION_ID)) {
        detailCalls += 1;
        return Promise.resolve(json({
          ...detailBody,
          sessionRevision: detailCalls > 1 ? NEXT_SESSION_REVISION : SESSION_REVISION,
        }));
      }
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: /Reader work/ }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Old later event")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Fresh session start")).toBeInTheDocument();
    expect(screen.queryByText("Old later event")).toBeNull();
  });

  it("blocks pagination while a poll is pending and re-enables it after cleanup", async () => {
    vi.useFakeTimers();
    let resolvePoll!: (response: Response) => void;
    const pendingPoll = new Promise<Response>((resolve) => {
      resolvePoll = resolve;
    });
    let detailCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(SESSION_ID)) {
        detailCalls += 1;
        return detailCalls === 1 ? Promise.resolve(json(detailBody)) : pendingPoll;
      }
      if (url.includes("afterOrdinal=2")) {
        return Promise.resolve(json({
          ...firstPage,
          items: [],
          nextAfterOrdinal: null,
          hasMore: false,
        }));
      }
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: /Reader work/ }));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    const loadMore = screen.getByRole("button", { name: "Load more events" });
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    act(() => vi.advanceTimersByTime(5_000));
    await act(async () => Promise.resolve());
    expect(detailCalls).toBe(2);
    expect(loadMore).toBeDisabled();
    fireEvent.click(loadMore);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("afterOrdinal=2")))
      .toBe(false);

    resolvePoll(json(detailBody));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(loadMore).toBeEnabled();
    fireEvent.click(loadMore);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("afterOrdinal=2")))
      .toBe(true);
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
        sessionRevision: SESSION_REVISION,
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
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    await act(async () => Promise.resolve());
    expect(readerDetailCalls).toBe(2);
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Refresh interval in seconds" }),
      { target: { value: "12" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Other session/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Other timeline")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Live updates" }))
      .not.toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Refresh interval in seconds" }))
      .toHaveValue(12);
    resolvePoll(json(detailBody));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(12_000);
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
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
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

  it("clears a failed reader selection when its error is dismissed", async () => {
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
    const alert = await screen.findByRole("alert");
    expect(window.location.search).toContain(`session=${SESSION_ID}`);

    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByRole("heading", { name: "Choose a session" }))
      .toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(screen.getByRole("button", { name: /Reader work/ }))
      .not.toHaveAttribute("aria-current");
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
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Poll failed");
  });
});
