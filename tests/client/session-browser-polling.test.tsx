// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionApp } from "../../src/client/SessionApp";
import { useSessionPolling } from "../../src/client/state/use-session-polling";
import type { ItemPageResponse, TimelineCursor } from "../../src/shared/api-contract";
import type { TimelineItem } from "../../src/shared/domain";
import {
  baseSession,
  directiveItem,
  json,
  NEXT_TIMELINE_CURSOR,
  SESSION_ID,
  TIMELINE_CURSOR,
} from "./session-browser.fixtures";

const OTHER_SESSION_ID = "otherabcdefghijklmnopqrs";
const LIVE_KEY = "codex-sessions-reader.live-updates.v1:";
const INTERVAL_KEY = "codex-sessions-reader.refresh-interval-seconds.v1";

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
});

describe("session Live updates", () => {
  it("stays off by default and starts and stops manually", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(page([message("Initial")])));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    const toggle = screen.getByRole("switch", { name: "Live updates" });

    await tick(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle);
    await tick(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(toggle);
    await tick(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("persists Live updates independently per session", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json(page([]))));
    vi.stubGlobal("fetch", fetchMock);
    const first = render(<SessionApp />);
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    expect(localStorage.getItem(`${LIVE_KEY}${SESSION_ID}`)).toBe("1");
    first.unmount();

    window.history.replaceState(null, "", `/sessions/${OTHER_SESSION_ID}`);
    const second = render(<SessionApp />);
    await flush();
    expect(screen.getByRole("switch", { name: "Live updates" })).toHaveAttribute("aria-checked", "false");
    second.unmount();

    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    render(<SessionApp />);
    await flush();
    expect(screen.getByRole("switch", { name: "Live updates" })).toHaveAttribute("aria-checked", "true");
  });

  it("falls back safely for an invalid persisted value", async () => {
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "yes");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page([]))));
    render(<SessionApp />);
    await flush();
    expect(screen.getByRole("switch", { name: "Live updates" })).toHaveAttribute("aria-checked", "false");
  });

  it("restores a valid refresh interval and uses it for polling", async () => {
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    localStorage.setItem(INTERVAL_KEY, "7");
    const fetchMock = vi.fn().mockResolvedValue(json(page([])));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    expect(screen.getByRole("spinbutton", { name: "Refresh interval in seconds" })).toHaveValue(7);
    await tick(6_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never polls archived sessions even when persistence enables it", async () => {
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page([], TIMELINE_CURSOR, false, true))));
    render(<SessionApp />);
    await flush();
    expect(screen.queryByRole("switch", { name: "Live updates" })).toBeNull();
    await tick(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serializes polling while an items request is unresolved", async () => {
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    let resolvePoll!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([])))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolvePoll = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();

    await tick(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvePoll(json(page([])));
    await flush();
  });

  it("does not restart a pending lazy detail request when polling rerenders the reader", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}?show=directive`);
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    let resolveDetail!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("/directive?")) {
        return new Promise<Response>((resolve) => { resolveDetail = resolve; });
      }
      return Promise.resolve(json(page([directiveItem], TIMELINE_CURSOR, true)));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    await flush();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/directive?")))
      .toHaveLength(1);

    await tick(2_000);
    const detailRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/directive?")
    );
    expect(detailRequests).toHaveLength(1);
    expect((detailRequests[0]?.[1] as RequestInit).signal?.aborted).toBe(false);

    resolveDetail(json({
      itemId: directiveItem.id,
      text: "Slow directive detail",
      truncated: false,
    }));
    await flush();
    expect(screen.getByText("Slow directive detail")).toBeInTheDocument();
  });

  it("keeps the reader frozen when lazy detail conflicts with an in-flight poll", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}?show=directive`);
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    let resolvePoll!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/directive?")) {
        return Promise.resolve(json({
          error: { code: "timeline_changed", message: "Cursor expired" },
        }, 409));
      }
      if (fetchMock.mock.calls.length === 1) {
        return Promise.resolve(json(page([directiveItem], TIMELINE_CURSOR, true)));
      }
      return new Promise<Response>((resolve) => { resolvePoll = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();

    await tick(2_000);
    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    await flush();
    expect(screen.getByText("Directive unavailable")).toBeInTheDocument();
    expect(screen.getByText("Session 内容已变化")).toBeInTheDocument();
    const itemRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/items?")
    );
    expect((itemRequests[1]?.[1] as RequestInit).signal?.aborted).toBe(true);

    resolvePoll(json(page([message("Obsolete poll result", 2)], NEXT_TIMELINE_CURSOR)));
    await flush();
    expect(screen.queryByText("Obsolete poll result")).toBeNull();
    expect(screen.getByText("Session 内容已变化")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more events" })).toBeDisabled();

    await tick(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("advances cursors across a multi-page backlog without duplicates", async () => {
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([message("One", 1)], TIMELINE_CURSOR, true)))
      .mockResolvedValueOnce(json(page([message("Two", 2)], NEXT_TIMELINE_CURSOR, true)))
      .mockResolvedValueOnce(json(page([message("Three", 3)], "opaque.timeline.tail" as TimelineCursor, false)));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    await tick(2_000);
    await tick(2_000);

    expect(screen.getAllByText(/One|Two|Three/)).toHaveLength(3);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("cursor=opaque.timeline.cursor");
    expect(fetchMock.mock.calls[2]?.[0]).toContain("cursor=opaque.timeline.next");
  });

  it("keeps the cursor unchanged after an empty poll", async () => {
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([], TIMELINE_CURSOR)))
      .mockResolvedValueOnce(json(page([], TIMELINE_CURSOR)))
      .mockResolvedValueOnce(json(page([], TIMELINE_CURSOR)));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    await tick(2_000);
    await tick(2_000);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("cursor=opaque.timeline.cursor");
    expect(fetchMock.mock.calls[2]?.[0]).toContain("cursor=opaque.timeline.cursor");
  });

  it("preserves visible content when polling fails", async () => {
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(page([message("Still visible")])))
      .mockResolvedValueOnce(json({ error: { code: "temporary_failure", message: "Poll failed" } }, 503)));
    render(<SessionApp />);
    await flush();
    await tick(2_000);
    expect(screen.getByText("Still visible")).toBeInTheDocument();
    expect(screen.getByText("Poll failed")).toBeInTheDocument();
  });

  it("pauses while hidden and resumes after visibility returns", async () => {
    localStorage.setItem(`${LIVE_KEY}${SESSION_ID}`, "1");
    const fetchMock = vi.fn().mockResolvedValue(json(page([])));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not revive a disposed polling loop after its request resolves", async () => {
    let resolvePoll!: () => void;
    const poll = vi.fn(() => new Promise<void>((resolve) => { resolvePoll = resolve; }));
    function Harness() {
      useSessionPolling(true, poll, 1_000);
      return null;
    }
    const view = render(<Harness />);
    await tick(1_000);
    expect(poll).toHaveBeenCalledTimes(1);
    view.unmount();
    resolvePoll();
    await flush();
    await tick(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function message(markdown: string, ordinal = 1): TimelineItem {
  return { kind: "message", id: `message-${ordinal}`, ordinal, timestamp: null,
    role: "assistant", phase: "final", itemType: null, markdown };
}

function page(
  items: TimelineItem[],
  cursor: TimelineCursor = TIMELINE_CURSOR,
  hasMore = false,
  archived = false,
): ItemPageResponse {
  return {
    session: { ...baseSession, archived, sourceId: "reader", diagnostics: [], itemCount: items.length },
    items,
    cursor,
    hasMore,
    interaction: { supported: false },
  };
}
