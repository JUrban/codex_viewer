// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import {
  baseSession,
  detailBody,
  entry,
  firstPage,
  json,
  listBody,
  OTHER_ID,
  SESSION_ID,
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
