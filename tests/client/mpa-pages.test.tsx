// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { SessionApp } from "../../src/client/SessionApp";
import type {
  ItemPageResponse,
  ListCursor,
  SessionListResponse,
  TimelineCursor,
} from "../../src/shared/api-contract";

describe("MPA pages", () => {
  it("renders the catalog as ordinary session links and forces freshness on refresh", async () => {
    const responses = [listResponse(), listResponse()];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const link = await screen.findByRole("link", { name: /Reader work/ });
    expect(link).toHaveAttribute("href", `/sessions/${SESSION_ID}`);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/v1/sessions?"),
      expect.anything(),
    );
    screen.getByRole("button", { name: "Refresh sessions" }).click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toContain("fresh=true");
  });

  it("restarts list pagination after stale_list_cursor without mixing results", async () => {
    const initial = listResponse();
    initial.total = 2;
    initial.nextCursor = "old-process-list-cursor" as ListCursor;
    const restarted = listResponse();
    restarted.sessions[0]!.session.title = "Restarted catalog";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify(initial), { status: 200 });
      }
      if (fetchMock.mock.calls.length === 2) {
        return new Response(JSON.stringify({
          error: { code: "stale_list_cursor", message: "Cursor expired" },
        }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(restarted), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(await screen.findByRole("link", { name: /Reader work/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Load more sessions/ }));
    expect(await screen.findByRole("link", { name: /Restarted catalog/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Reader work/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).not.toContain("cursor=");
  });

  it("opens the reader with one items request and preserves show in its URL", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}?show=tool`);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(itemPage()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);

    expect(await screen.findByRole("heading", { name: "Reader work" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "tool" })).toBeChecked();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`/api/v1/sessions/${SESSION_ID}/items?limit=300`);
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("cursor=");
    expect(screen.queryByRole("button", { name: /^Refresh/ })).not.toBeInTheDocument();
  });

  it("retries a failed initial open instead of allowing a permanent loading state", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify({
          error: { code: "temporary_failure", message: "Temporarily unavailable" },
        }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(itemPage()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);

    expect(await screen.findByText("Temporarily unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry opening session" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded items and freezes pagination after timeline_changed", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    const first = itemPage();
    first.hasMore = true;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify(first), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { code: "timeline_changed", message: "Timeline changed" },
      }), { status: 409, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("Session 内容已变化")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more events" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新载入最新版本" })).toBeInTheDocument();
  });

  it("turns an expired lazy-detail cursor into the shared reload state", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}?show=directive`);
    const first = itemPage();
    first.items = [{
      kind: "directive",
      id: "directive-4",
      ordinal: 4,
      timestamp: null,
      hasDetail: true,
      summary: "Developer instructions",
      charCount: 500,
      truncated: false,
    }];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify(first), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { code: "timeline_changed", message: "Cursor expired" },
      }), { status: 409, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Show directive" }));
    expect(await screen.findByText("Directive unavailable")).toBeInTheDocument();
    expect(screen.getByText("Session 内容已变化")).toBeInTheDocument();
    expect(screen.getByText("Developer instructions")).toBeInTheDocument();
  });

  it("keeps the old timeline when reload fails and replaces it only after success", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    const first = itemPage();
    first.hasMore = true;
    const replacement = itemPage();
    replacement.items = [{
      kind: "message",
      id: "message-2",
      ordinal: 2,
      timestamp: null,
      role: "assistant",
      phase: "final",
      itemType: null,
      markdown: "Fresh timeline",
    }];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const call = fetchMock.mock.calls.length;
      if (call === 1) return new Response(JSON.stringify(first), { status: 200 });
      if (call === 2) {
        return new Response(JSON.stringify({
          error: { code: "timeline_changed", message: "Timeline changed" },
        }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      if (call === 3) {
        return new Response(JSON.stringify({
          error: { code: "temporary_failure", message: "Reload failed" },
        }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(replacement), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionApp />);

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新载入最新版本" }));
    expect(await screen.findByText("Reload failed")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Session 内容已变化")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新载入最新版本" }));
    expect(await screen.findByText("Fresh timeline")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Session 内容已变化")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

const SESSION_ID = "abcdefghijklmnopqrstuvwx";

function listResponse(): SessionListResponse {
  return {
    sessions: [{ session: summary(), matches: [] }],
    projects: [{ project: "/project/reader", count: 1 }],
    total: 1,
    nextCursor: null,
    partial: false,
    warnings: [],
  };
}

function itemPage(): ItemPageResponse {
  return {
    session: { ...summary(), sourceId: "reader", diagnostics: [], itemCount: 1 },
    items: [{
      kind: "message",
      id: "message-1",
      ordinal: 1,
      timestamp: null,
      role: "assistant",
      phase: "final",
      itemType: null,
      markdown: "Ready",
    }],
    cursor: "opaque.timeline.cursor" as TimelineCursor,
    hasMore: false,
    interaction: { supported: false },
  };
}

function summary() {
  return {
    id: SESSION_ID,
    origin: {
      sourceType: "codex-jsonl",
      sourceInstanceId: "source",
      agentName: "Codex",
      agentVersion: null,
      formatVersion: null,
    },
    title: "Reader work",
    preview: null,
    cwd: "/project/reader",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:01Z",
    archived: false,
    parentId: null,
    childIds: [],
    agent: null,
    messageCount: 1,
    toolCount: 0,
    warningCount: 0,
  };
}
