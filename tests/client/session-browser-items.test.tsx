// @vitest-environment jsdom

import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionApp } from "../../src/client/SessionApp";
import { DirectiveItem } from "../../src/client/components/DirectiveItem";
import { Timeline } from "../../src/client/components/Timeline";
import { ToolItem } from "../../src/client/components/ToolItem";
import type { ItemPageResponse, LiveRevision, TimelineCursor } from "../../src/shared/api-contract";
import type { TimelineItem } from "../../src/shared/domain";
import {
  baseSession,
  directiveItem,
  json,
  NEXT_TIMELINE_CURSOR,
  SESSION_ID,
  TIMELINE_CURSOR,
  toolItem,
} from "./session-browser.fixtures";

describe("session reader items", () => {
  it("renders inline directives without requesting detail", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DirectiveItem
      item={{ kind: "directive", id: "directive-inline", ordinal: 1, timestamp: null,
        hasDetail: false, text: "Inline policy", charCount: 13 }}
      sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR}
      onTimelineConflict={vi.fn()}
    />);
    expect(screen.getByText("Inline policy")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("labels tool stages and renders only stage-appropriate detail", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ itemId: "tool-call", input: "args", output: "hidden", truncated: false }))
      .mockResolvedValueOnce(json({ itemId: "tool-output", input: "args", output: "result", truncated: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<>
      <ToolItem item={{ ...toolItem, id: "tool-call", stage: "call" }} sessionId={SESSION_ID}
        cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />
      <ToolItem item={{ ...toolItem, id: "tool-output", stage: "output", status: "failed" }} sessionId={SESSION_ID}
        cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />
    </>);

    fireEvent.click(screen.getAllByRole("button", { name: "Show tool detail" })[0]!);
    expect(await screen.findByText("args")).toBeInTheDocument();
    expect(screen.queryByText("hidden")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("result")).toBeInTheDocument();
    expect(screen.getByText(/Tool output · failed/)).toBeInTheDocument();
  });

  it("opens a session under React StrictMode", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(json(page([message("message-1", 1, "Strict ready")]))),
    ));
    render(<StrictMode><SessionApp /></StrictMode>);
    expect(await screen.findByText("Strict ready")).toBeInTheDocument();
  });

  it("loads later pages without duplicating an overlapping item", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    const first = page([message("message-1", 1, "First")], TIMELINE_CURSOR, true);
    const second = page([
      message("message-1", 1, "First"),
      message("message-2", 2, "Second"),
    ], NEXT_TIMELINE_CURSOR, false);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json(second)));
    render(<SessionApp />);

    await screen.findByText("First");
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(screen.getAllByText("First")).toHaveLength(1);
  });

  it("keeps Load more available when all loaded events are filtered", () => {
    render(<Timeline
      items={[{ kind: "internal", id: "internal-1", ordinal: 1, timestamp: null,
        eventType: "reasoning", summary: "hidden upstream" }]}
      sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR}
      hasMore
      loading={false}
      onLoadMore={vi.fn()}
      onTimelineConflict={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: "Load more events" })).toBeEnabled();
  });

  it("loads tool and directive details concurrently without changing their cursor", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL) => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    render(<>
      <ToolItem item={toolItem} sessionId={SESSION_ID} cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />
      <DirectiveItem item={directiveItem} sessionId={SESSION_ID} cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />
    </>);

    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("cursor=opaque.timeline.cursor"))).toBe(true);
    pending[1]!(json({ itemId: directiveItem.id, text: "Directive body", truncated: false }));
    pending[0]!(json({ itemId: toolItem.id, input: "input", output: "output", truncated: false }));
    expect(await screen.findByText("Directive body")).toBeInTheDocument();
    expect(await screen.findByText("input")).toBeInTheDocument();
  });

  it("keeps pending lazy detail when the cursor advances", async () => {
    let resolveDetail!: (response: Response) => void;
    const pendingDetail = new Promise<Response>((resolve) => { resolveDetail = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(pendingDetail);
    const onTimelineConflict = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ToolItem item={toolItem} sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR} onTimelineConflict={onTimelineConflict} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(<ToolItem item={toolItem} sessionId={SESSION_ID}
      cursor={NEXT_TIMELINE_CURSOR} onTimelineConflict={onTimelineConflict} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(false);
    resolveDetail(json({ itemId: toolItem.id, input: "loaded detail", output: null, truncated: false }));
    expect(await screen.findByText("loaded detail")).toBeInTheDocument();
  });

  it("aborts pending lazy detail when it is closed", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<ToolItem item={toolItem} sessionId={SESSION_ID}
      cursor={TIMELINE_CURSOR} onTimelineConflict={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Hide tool detail" }));

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("toggles technical-event visibility for the current page", async () => {
    window.history.replaceState(null, "", `/sessions/${SESSION_ID}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(page([
      { kind: "internal", id: "internal-1", ordinal: 1, timestamp: null,
        eventType: "reasoning", summary: "Internal body" },
    ]))));
    render(<SessionApp />);
    const checkbox = await screen.findByRole("checkbox", { name: "internal" });
    fireEvent.click(checkbox);
    expect(screen.getByText(/Internal body/)).toBeInTheDocument();
  });
});

function message(id: string, ordinal: number, markdown: string): TimelineItem {
  return { kind: "message", id, ordinal, timestamp: null, role: "assistant",
    phase: "final", itemType: null, markdown };
}

function page(
  items: TimelineItem[],
  cursor: TimelineCursor = TIMELINE_CURSOR,
  hasMore = false,
): ItemPageResponse {
  return {
    session: { ...baseSession, sourceId: "reader", diagnostics: [], itemCount: items.length },
    items,
    cursor,
    hasMore,
    interaction: { supported: false },
    liveRevision: "opaque.live.revision" as LiveRevision,
  };
}
