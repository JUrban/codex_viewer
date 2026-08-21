// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionApp } from "../../src/client/SessionApp";
import type {
  ItemPageResponse,
  LiveRevision,
  SessionLiveResponse,
  TimelineCursor,
} from "../../src/shared/api-contract";
import type { TimelineItem } from "../../src/shared/domain";
import { installIntersectionObserver, intersectLatest } from "./intersection-observer";
import { LIVE_UPDATES_STORAGE_KEY } from "../../src/client/state/use-live-updates-preference";
import {
  baseSession,
  json,
  LIVE_REVISION,
  NEXT_TIMELINE_CURSOR,
  SESSION_ID,
  TIMELINE_CURSOR,
} from "./session-browser.fixtures";

const NEXT_REVISION = "opaque.live.next" as LiveRevision;
const OTHER_LIVE_REVISION = "opaque.live.other" as LiveRevision;
const TAIL_CURSOR = "opaque.timeline.tail" as TimelineCursor;

beforeEach(() => {
  window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
});

describe("session Live updates", () => {
  it("stays off by default and keeps at most one cancellable Live request", async () => {
    let pendingSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/live?")) {
        pendingSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(json(page([message("Initial")])));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const toggle = screen.getByRole("switch", { name: "Live updates" });
    fireEvent.click(toggle);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/live?");
    expect(pendingSignal?.aborted).toBe(false);
    fireEvent.click(toggle);
    await flush();
    expect(pendingSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never opens Live for archived sessions", async () => {
    sessionStorage.setItem(LIVE_UPDATES_STORAGE_KEY, "true");
    installIntersectionObserver();
    const fetchMock = vi.fn().mockResolvedValue(json(page([], TIMELINE_CURSOR, true, true)));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    expect(screen.queryByRole("switch", { name: "Live updates" })).toBeNull();
    expect(document.querySelector(".infinite-scroll-sentinel")).toBeInTheDocument();
    expect(sessionStorage.getItem(LIVE_UPDATES_STORAGE_KEY)).toBe("true");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores the tab preference after the reader mounts again", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("/live?")) return new Promise<Response>(() => {});
      return Promise.resolve(json(page([])));
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = render(<SessionApp />);
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await flush();
    expect(sessionStorage.getItem(LIVE_UPDATES_STORAGE_KEY)).toBe("true");

    first.unmount();
    render(<SessionApp />);
    await flush();

    expect(screen.getByRole("switch", { name: "Live updates" })).toBeChecked();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("/live?");
  });

  it("loads ordinary items pages until a multi-page Live backlog is caught up", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([message("One")], TIMELINE_CURSOR)))
      .mockResolvedValueOnce(json(live(true, LIVE_REVISION)))
      .mockResolvedValueOnce(json(page([message("Two", 2)], NEXT_TIMELINE_CURSOR, true, false, NEXT_REVISION)))
      .mockResolvedValueOnce(json(live(true, NEXT_REVISION, { supported: false }, NEXT_TIMELINE_CURSOR)))
      .mockResolvedValueOnce(json(page([message("Three", 3)], TAIL_CURSOR, false, false, NEXT_REVISION)))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    enableLiveUpdates();
    await flush(10);

    expect(screen.getByText("One")).toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
    expect(screen.getByText("Three")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/live?");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/items?");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("cursor=opaque.timeline.cursor");
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("after=opaque.live.next");
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("cursor=opaque.timeline.next");
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain("/items?");
    expect(String(fetchMock.mock.calls[5]?.[0])).toContain("cursor=opaque.timeline.tail");
  });

  it("discards an old Live response after manual pagination advances the snapshot", async () => {
    installIntersectionObserver();
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([message("One")], TIMELINE_CURSOR, true)))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(json(page([message("Two", 2)], NEXT_TIMELINE_CURSOR, false, false, NEXT_REVISION)))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    enableLiveUpdates();
    await flush();
    expect(document.querySelector(".infinite-scroll-sentinel")).not.toBeInTheDocument();
    enableLiveUpdates();
    intersectLatest();
    await flush(8);
    expect(screen.getByText("Two")).toBeInTheDocument();

    const obsolete = live(false, OTHER_LIVE_REVISION);
    resolveOld(json({
      ...obsolete,
      session: { ...obsolete.session, title: "Obsolete title" },
    }));
    await flush(8);
    expect(screen.queryByRole("heading", { name: "Obsolete title" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Reader work" })).toBeInTheDocument();
  });

  it("adopts interaction and metadata-only Live changes without advancing cursor", async () => {
    const changed = live(false, NEXT_REVISION, {
      supported: true,
      state: "connected",
      activation: "activate",
    });
    changed.session = {
      ...changed.session,
      title: "Changed title",
      itemCount: 7,
      updatedAt: "2026-08-08T12:34:00.000Z",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([])))
      .mockResolvedValueOnce(json(changed))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    enableLiveUpdates();
    await flush(10);
    expect(screen.getByRole("heading", { name: "Changed title" })).toBeInTheDocument();
    expect(document.title).toBe("Changed title · Codex Sessions");
    const localTime = new Date(changed.session.updatedAt!).toLocaleTimeString(undefined, {
      timeStyle: "medium",
    });
    expect(screen.getByText(`7 events · Updated ${localTime}`)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("cursor=opaque.timeline.cursor");
  });

  it("freezes the reader on a Live timeline conflict", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(page([message("Preserved")])))
      .mockResolvedValueOnce(json({
        error: { code: "timeline_changed", message: "Timeline changed" },
      }, 409)));
    render(<SessionApp />);
    await flush();
    enableLiveUpdates();
    await flush(10);
    expect(screen.getByText("Preserved")).toBeInTheDocument();
    expect(screen.getByText("Session 内容已变化")).toBeInTheDocument();
  });

  it("reconnects immediately after consecutive 204 responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([])))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    enableLiveUpdates();
    await flush(10);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("backs off retryable failures and stops on terminal 4xx responses", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page([])))
      .mockResolvedValueOnce(json({ error: { code: "busy", message: "Busy" } }, 503))
      .mockResolvedValueOnce(json({ error: { code: "invalid_query", message: "Stop" } }, 400));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    enableLiveUpdates();
    await flush(8);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Stop")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Live updates" })).not.toBeChecked();
    expect(sessionStorage.getItem(LIVE_UPDATES_STORAGE_KEY)).toBe("false");
    vi.useRealTimers();
  });

  it("aborts while hidden and resumes immediately when visible", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/live?")) return Promise.resolve(json(page([])));
      signals.push(init?.signal as AbortSignal);
      return abortable(init?.signal as AbortSignal);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);
    await flush();
    enableLiveUpdates();
    await flush();
    expect(signals).toHaveLength(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
  });
});

function enableLiveUpdates(): void {
  fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
}

async function flush(turns = 4) {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) await Promise.resolve();
  });
}

function abortable(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(
      new DOMException("The operation was aborted", "AbortError"),
    ), { once: true });
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
  liveRevision: LiveRevision = LIVE_REVISION,
): ItemPageResponse {
  return {
    session: { ...baseSession, archived, sourceId: "reader", diagnostics: [], itemCount: items.length },
    items, cursor, hasMore, interaction: { supported: false }, liveRevision,
  };
}

function live(
  hasMore: boolean,
  liveRevision: LiveRevision,
  interaction: SessionLiveResponse["interaction"] = { supported: false },
  cursor: TimelineCursor = TIMELINE_CURSOR,
): SessionLiveResponse {
  return {
    session: { ...baseSession, sourceId: "reader", diagnostics: [], itemCount: hasMore ? 2 : 0 },
    cursor,
    hasMore,
    interaction,
    liveRevision,
  };
}
