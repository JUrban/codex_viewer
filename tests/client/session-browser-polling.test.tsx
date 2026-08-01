// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

describe("session polling and failures", () => {
  it("keeps polling off by default and starts and stops it manually", async () => {
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
    })).toHaveValue(2);
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(sessionCalls).toBe(1);

    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(sessionCalls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(sessionCalls).toBe(2);

    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(sessionCalls).toBe(2);
  });

  it("persists Live updates independently for each session and restores them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const other = { ...baseSession, id: OTHER_ID, title: "Other session" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const session = url.includes(OTHER_ID) ? other : baseSession;
      if (url.includes("/items")) {
        return Promise.resolve(json({
          ...firstPage,
          context: {
            ...firstPage.context,
            session: { ...firstPage.context.session, ...session },
          },
        }));
      }
      if (url.includes(SESSION_ID) || url.includes(OTHER_ID)) {
        return Promise.resolve(json({
          ...detailBody,
          context: {
            ...detailBody.context,
            session: { ...detailBody.context.session, ...session },
          },
        }));
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
    expect(window.localStorage.getItem(
      `codex-sessions-reader.live-updates.v1:${SESSION_ID}`,
    )).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: /Other session/ }));
    await screen.findByRole("heading", { name: "Other session" });
    expect(screen.getByRole("switch", { name: "Live updates" }))
      .toHaveAttribute("aria-checked", "false");

    fireEvent.click(screen.getByRole("button", { name: /Reader work/ }));
    await screen.findByRole("heading", { name: "Reader work" });
    expect(screen.getByRole("switch", { name: "Live updates" }))
      .toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    expect(window.localStorage.getItem(
      `codex-sessions-reader.live-updates.v1:${SESSION_ID}`,
    )).toBeNull();
  });

  it("falls back safely when a stored Live updates value is invalid", async () => {
    window.localStorage.setItem(
      `codex-sessions-reader.live-updates.v1:${SESSION_ID}`,
      "unexpected",
    );
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    expect(screen.getByRole("switch", { name: "Live updates" }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("keeps Live updates off when localStorage is unavailable", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => { throw new Error("storage blocked"); });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    expect(screen.getByRole("switch", { name: "Live updates" }))
      .toHaveAttribute("aria-checked", "false");
    getItem.mockRestore();
  });

  it("uses one standard Live update loop for timeline and interaction mutations", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sessionCalls = 0;
    const urls: string[] = [];
    const available = {
      supported: true as const,
      state: "idle" as const,
      activation: "activate",
      canSendMessage: true,
      canInterrupt: true,
      canSendEscape: true,
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/messages") || url.endsWith("/interrupt") || url.endsWith("/keys")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes("/items")) {
        return Promise.resolve(json({ ...firstPage, interaction: available }));
      }
      if (url.includes(SESSION_ID)) {
        sessionCalls += 1;
        return Promise.resolve(json({
          ...detailBody,
          interaction: sessionCalls === 1
            ? available
            : { ...available, state: "running", canSendMessage: false },
        }));
      }
      return Promise.resolve(json(listBody));
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    expect(screen.queryByLabelText("Session interaction")).toBeNull();
    fireEvent.change(screen.getByRole("spinbutton", {
      name: "Refresh interval in seconds",
    }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    expect(screen.getByLabelText("Session interaction")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message to agent"), {
      target: { value: "status?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => Promise.resolve());
    expect(urls.some((url) => url.endsWith("/messages"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    await act(async () => Promise.resolve());
    expect(urls.some((url) => url.endsWith("/interrupt"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    await act(async () => Promise.resolve());
    expect(urls.some((url) => url.endsWith("/keys"))).toBe(true);

    expect(sessionCalls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sessionCalls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(sessionCalls).toBe(2);
    expect(screen.getByRole("heading", { name: "Agent is running" }))
      .toBeInTheDocument();
    expect(urls.every((url) => !url.endsWith("/interaction"))).toBe(true);
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
    const liveUpdatesKey = `codex-sessions-reader.live-updates.v1:${SESSION_ID}`;
    window.localStorage.setItem(liveUpdatesKey, "1");
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
    expect(screen.queryByLabelText("Session interaction")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(sessionCalls).toBe(1);
    expect(window.localStorage.getItem(liveUpdatesKey)).toBe("1");
  });

  it("loads an appended page when the confirmed prefix remains valid", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
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
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    await screen.findByText("Appended event");
  });

  it("follows one appended tail page without a continuity request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sessionCalls = 0;
    const tailPage = {
      ...firstPage,
      context: readContext(SESSION_REVISION, 2, false),
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
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
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Appended event")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(
      ([url]) => String(url).includes("sessionRevision=bbbb") &&
        String(url).includes("throughOrdinal=2"),
    )).toBe(true);
    expect(fetchMock.mock.calls.every(
      ([url]) => !String(url).includes("/continuity"),
    )).toBe(true);
  });

  it("adopts latest metadata while unread items remain", async () => {
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
    const continuityAlert = screen.getByRole("alert");
    const loadMore = screen.getByRole("button", { name: "Load more events" });
    expect(continuityAlert).toHaveTextContent("Session 内容已变化");
    expect(loadMore).toBeDisabled();
    expect(loadMore.compareDocumentPosition(continuityAlert) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "刷新到最新版本" }));
    expect(await screen.findByText("Replacement timeline")).toBeInTheDocument();
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.queryByText("Old tool detail")).toBeNull();
    expect(screen.getByRole("button", { name: "Show tool detail" }))
      .toBeInTheDocument();
  });

  it("keeps the continuity notice last when refreshing the changed session fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sessionCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.includes(`/${SESSION_ID}?`)) {
        return Promise.resolve(json({
          error: {
            code: "stale_timeline_prefix",
            message: "prefix changed",
          },
        }, 409));
      }
      if (url.endsWith(SESSION_ID)) {
        sessionCalls += 1;
        if (sessionCalls === 1) return Promise.resolve(json(detailBody));
        return Promise.resolve(json({
          error: { code: "internal_error", message: "Refresh failed" },
        }, 500));
      }
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    fireEvent.click(screen.getByRole("switch", { name: "Live updates" }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    fireEvent.click(screen.getByRole("button", { name: "刷新到最新版本" }));

    await screen.findByText("Refresh failed");
    const alerts = screen.getAllByRole("alert");
    const loadError = alerts.find((alert) => alert.textContent?.includes("Refresh failed"));
    const continuityAlert = alerts.find((alert) => alert.textContent?.includes("Session 内容已变化"));
    expect(loadError).toBeDefined();
    expect(continuityAlert).toBeDefined();
    expect(loadError!.compareDocumentPosition(continuityAlert!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
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
    const visibleContent = screen.getByText("Hello");
    const alert = screen.getByRole("alert");
    expect(visibleContent).toBeInTheDocument();
    expect(alert).toHaveTextContent("Poll failed");
    expect(visibleContent.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Poll failed")).toBeNull();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("keeps the standalone error state when initially opening a session fails", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/${SESSION_ID}`)) {
        return Promise.resolve(json({
          error: { code: "internal_error", message: "Open failed" },
        }, 500));
      }
      return Promise.resolve(json(listBody));
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load sessionOpen failed",
    );
    expect(screen.queryByRole("heading", { name: "Reader work" })).toBeNull();
    expect(screen.queryByText("Hello")).toBeNull();
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
