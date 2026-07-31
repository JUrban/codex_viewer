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
  NEXT_SESSION_REVISION,
  OTHER_ID,
  readContext,
  SESSION_ID,
  SESSION_REVISION,
  toolItem,
} from "./session-browser.fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.history.replaceState(null, "", "/");
});

describe("session polling and failures", () => {
  it("keeps polling off by default and starts and stops it manually", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(`/${SESSION_ID}`)) {
        sessionCalls += 1;
        return Promise.resolve(json(detailBody));
      }
      return Promise.resolve(json(listBody));
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(sessionCalls).toBe(1);

    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sessionCalls).toBe(2);

    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(sessionCalls).toBe(2);
  });

  it("restores and applies a persisted refresh interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem(
      "codex-sessions-reader.refresh-interval-seconds.v1",
      "9",
    );
    let sessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(`/${SESSION_ID}`)) {
        sessionCalls += 1;
        return Promise.resolve(json(detailBody));
      }
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    expect(screen.getByRole("spinbutton", {
      name: "Refresh interval in seconds",
    })).toHaveValue(9);
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(sessionCalls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(sessionCalls).toBe(2);
  });

  it("does not poll an archived session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const archived = { ...baseSession, archived: true };
    const archivedContext = {
      ...readContext(SESSION_REVISION, 2, false),
      session: {
        ...readContext().session,
        ...archived,
      },
    };
    let sessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) {
        return Promise.resolve(json({
          ...firstPage,
          context: archivedContext,
        }));
      }
      if (url.includes(`/${SESSION_ID}`)) {
        sessionCalls += 1;
        return Promise.resolve(json({
          context: {
            ...archivedContext,
            cursor: readContext(SESSION_REVISION, 0, true).cursor,
          },
        }));
      }
      return Promise.resolve(json({
        ...listBody,
        sessions: [entry(archived)],
      }));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    expect(screen.queryByRole("switch", { name: "Live updates" })).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(sessionCalls).toBe(1);
  });

  it("migrates an append-only cursor and follows one tail page without continuity", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sessionCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items") && url.includes("throughOrdinal=2")) {
        return Promise.resolve(json({
          context: readContext(NEXT_SESSION_REVISION, 3, false),
          items: [{
            kind: "message",
            id: "message-3",
            ordinal: 3,
            timestamp: null,
            role: "assistant",
            phase: "final",
            markdown: "Appended event",
          }],
        }));
      }
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(`/${SESSION_ID}`)) {
        sessionCalls += 1;
        return Promise.resolve(json(sessionCalls === 1
          ? detailBody
          : { context: readContext(NEXT_SESSION_REVISION, 2, true) }));
      }
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    await screen.findByText("Appended event");
    // Reset to a tail-following initial response for the actual polling assertion.
    cleanup();
    sessionCalls = 0;
    const tailPage = {
      ...firstPage,
      context: readContext(SESSION_REVISION, 2, false),
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items") && url.includes("sessionRevision=bbbb")) {
        return Promise.resolve(json({
          context: readContext(NEXT_SESSION_REVISION, 3, false),
          items: [{
            kind: "message",
            id: "message-3",
            ordinal: 3,
            timestamp: null,
            role: "assistant",
            phase: "final",
            markdown: "Appended event",
          }],
        }));
      }
      if (url.includes("/items")) return Promise.resolve(json(tailPage));
      if (url.includes(`/${SESSION_ID}`)) {
        sessionCalls += 1;
        return Promise.resolve(json(sessionCalls === 1
          ? detailBody
          : { context: readContext(NEXT_SESSION_REVISION, 2, true) }));
      }
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Appended event")).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(
      ([url]) => !String(url).includes("/continuity"),
    )).toBe(true);
  });

  it("migrates only metadata while unread items remain", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sessionCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items/tool-2/tool")) {
        const context = readContext(
          sessionCalls > 1 ? NEXT_SESSION_REVISION : SESSION_REVISION,
        );
        return Promise.resolve(json({
          context: sessionCalls > 1
            ? { ...context, session: { ...context.session, title: "Updated title" } }
            : context,
          sessionId: SESSION_ID,
          itemId: toolItem.id,
          input: null,
          output: "Stable tool detail",
          truncated: false,
        }));
      }
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(`/${SESSION_ID}`)) {
        sessionCalls += 1;
        return Promise.resolve(json(sessionCalls === 1
          ? detailBody
          : {
              context: {
                ...readContext(NEXT_SESSION_REVISION, 2, true),
                session: {
                  ...readContext().session,
                  title: "Updated title",
                },
              },
            }));
      }
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("checkbox", { name: "tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("Stable tool detail")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByRole("heading", { name: "Updated title" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide tool detail" }))
      .toBeInTheDocument();
    expect(screen.getByText("Stable tool detail")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(
      ([url]) => String(url).includes(`/${SESSION_ID}/items?`),
    )).toHaveLength(1);
  });

  it("freezes the old view after a prefix conflict until explicit refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let unconditionalSessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items/tool-2/tool")) {
        return Promise.resolve(json({
          context: readContext(),
          sessionId: SESSION_ID,
          itemId: toolItem.id,
          input: null,
          output: "Old tool detail",
          truncated: false,
        }));
      }
      if (url.includes("/items")) {
        return Promise.resolve(json(unconditionalSessionCalls > 1
          ? {
              context: readContext(NEXT_SESSION_REVISION, 2, false),
              items: [
                {
                  kind: "message",
                  id: "message-1",
                  ordinal: 1,
                  timestamp: null,
                  role: "user",
                  phase: null,
                  markdown: "Replacement timeline",
                },
                { ...toolItem, preview: "replacement" },
              ],
            }
          : firstPage));
      }
      if (url.includes(`/${SESSION_ID}?`)) {
        return Promise.resolve(json({
          error: {
            code: "stale_timeline_prefix",
            message: "prefix changed",
          },
        }, 409));
      }
      if (url.endsWith(SESSION_ID)) {
        unconditionalSessionCalls += 1;
        return Promise.resolve(json(unconditionalSessionCalls > 1
          ? { context: readContext(NEXT_SESSION_REVISION, 0, true) }
          : detailBody));
      }
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("checkbox", { name: "tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("Old tool detail")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Old tool detail")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Session 内容已变化");
    expect(screen.getByRole("button", { name: "Load more events" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "刷新到最新版本" }));
    expect(await screen.findByText("Replacement timeline")).toBeInTheDocument();
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.queryByText("Old tool detail")).toBeNull();
    expect(screen.getByRole("button", { name: "Show tool detail" }))
      .toBeInTheDocument();
  });

  it("preserves visible content when polling fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(`/${SESSION_ID}`)) {
        sessionCalls += 1;
        return sessionCalls === 1
          ? Promise.resolve(json(detailBody))
          : Promise.resolve(json({
              error: { code: "internal_error", message: "Poll failed" },
            }, 500));
      }
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Poll failed");
  });

  it("does not revive a disposed poll after navigation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolvePoll!: (response: Response) => void;
    const poll = new Promise<Response>((resolve) => {
      resolvePoll = resolve;
    });
    let readerSessionCalls = 0;
    const other = { ...baseSession, id: OTHER_ID, title: "Other session" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(OTHER_ID) && url.includes("/items")) {
        return Promise.resolve(json({
          context: {
            ...readContext(SESSION_REVISION, 1, false),
            session: { ...readContext().session, ...other },
          },
          items: [{
            kind: "message",
            id: "other-1",
            ordinal: 1,
            timestamp: null,
            role: "user",
            phase: null,
            markdown: "Other timeline",
          }],
        }));
      }
      if (url.includes(OTHER_ID)) {
        return Promise.resolve(json({
          context: {
            ...readContext(SESSION_REVISION, 0, true),
            session: { ...readContext().session, ...other },
          },
        }));
      }
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(SESSION_ID)) {
        readerSessionCalls += 1;
        return readerSessionCalls === 1
          ? Promise.resolve(json(detailBody))
          : poll;
      }
      return Promise.resolve(json({
        ...listBody,
        sessions: [entry(baseSession), entry(other)],
        total: 2,
      }));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    fireEvent.click(screen.getByRole("button", { name: /Other session/ }));
    expect(await screen.findByText("Other timeline")).toBeInTheDocument();
    resolvePoll(json({
      context: {
        ...readContext(NEXT_SESSION_REVISION, 2, false),
        session: { ...readContext().session, title: "Obsolete reader" },
      },
    }));
    await act(async () => Promise.resolve());
    expect(screen.queryByText("Obsolete reader")).toBeNull();
    expect(screen.getByText("Other timeline")).toBeInTheDocument();
  });
});
