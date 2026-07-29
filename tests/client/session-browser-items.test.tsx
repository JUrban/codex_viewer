// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { DirectiveItem } from "../../src/client/components/DirectiveItem";
import { Timeline } from "../../src/client/components/Timeline";
import { ToolItem } from "../../src/client/components/ToolItem";
import type { ItemPageResponse } from "../../src/shared/api-contract";
import {
  baseSession,
  detailBody,
  directiveItem,
  entry,
  firstPage,
  json,
  listBody,
  OTHER_ID,
  SESSION_ID,
  toolItem,
} from "./session-browser.fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.history.replaceState(null, "", "/");
});

describe("session timeline interactions", () => {
  it("loads later pages without duplicates and fetches tool text only on expansion", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items/tool-2/tool")) return Promise.resolve(json({
        generation: 1, sessionId: SESSION_ID, itemId: "tool-2",
        input: "<unsafe stays text>", output: "done", truncated: true,
      }));
      if (url.includes("afterOrdinal=2")) return Promise.resolve(json({
        ...firstPage, items: [
          firstPage.items[1],
          { kind: "message", id: "message-3", ordinal: 3, timestamp: null, role: "assistant", phase: "final", markdown: "Finished" },
        ], nextAfterOrdinal: null, hasMore: false,
      }));
      if (url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/tool-2/tool"))).toBe(false);
    expect(screen.queryByText(/exec/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "tool" }));
    expect(await screen.findByText(/exec/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("Finished")).toBeInTheDocument();
    expect(screen.getAllByText(/exec/)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("<unsafe stays text>")).toBeInTheDocument();
    expect(screen.queryByText("unsafe stays text", { selector: "em" })).not.toBeInTheDocument();
  });

  it("keeps load more available when the loaded range is fully filtered", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("afterOrdinal=2")) return Promise.resolve(json({
        ...firstPage,
        items: [{
          kind: "message",
          id: "message-3",
          ordinal: 3,
          timestamp: null,
          role: "assistant",
          phase: "final",
          markdown: "Visible on the next page",
        }],
        nextAfterOrdinal: null,
        hasMore: false,
      }));
      if (url.includes("/items")) return Promise.resolve(json({
        ...firstPage,
        items: [toolItem],
        nextAfterOrdinal: 2,
        hasMore: true,
      }));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText(
      "No visible events in the loaded range. Load more events or change a visibility filter.",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("Visible on the next page")).toBeInTheDocument();
  });

  it("ignores an obsolete timeline page after switching sessions", async () => {
    let resolveOldPage!: (response: Response) => void;
    const oldPage = new Promise<Response>((resolve) => {
      resolveOldPage = resolve;
    });
    const other = { ...baseSession, id: OTHER_ID, title: "Other session" };
    const otherDetail = {
      generation: 1,
      session: { ...other, diagnostics: [], itemCount: 1 },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(SESSION_ID) && url.includes("afterOrdinal=2")) return oldPage;
      if (url.includes(OTHER_ID) && url.includes("/items")) return Promise.resolve(json({
        ...firstPage,
        items: [{
          kind: "message", id: "message-1", ordinal: 1, timestamp: null,
          role: "assistant", phase: "final", markdown: "Other timeline",
        }],
        nextAfterOrdinal: null,
        hasMore: false,
      }));
      if (url.endsWith(OTHER_ID)) return Promise.resolve(json(otherDetail));
      if (url.includes(SESSION_ID) && url.includes("/items")) return Promise.resolve(json(firstPage));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json({
        ...listBody,
        sessions: [entry(baseSession), entry(other)],
        total: 2,
      }));
    }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Reader work/ }));
    await screen.findByText("Hello");
    await user.click(screen.getByRole("button", { name: "Load more events" }));
    await user.click(screen.getByRole("button", { name: /Other session/ }));
    expect(await screen.findByText("Other timeline")).toBeInTheDocument();
    resolveOldPage(json({
      ...firstPage,
      items: [{
        kind: "message", id: "message-3", ordinal: 3, timestamp: null,
        role: "assistant", phase: "final", markdown: "Obsolete timeline",
      }],
      nextAfterOrdinal: null,
      hasMore: false,
    }));
    await waitFor(() => expect(screen.queryByText("Obsolete timeline")).toBeNull());
    expect(screen.getByText("Other timeline")).toBeInTheDocument();
  });

  it("isolates tool detail by session identity", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(json({
        generation: 1,
        sessionId: url.includes(OTHER_ID) ? OTHER_ID : SESSION_ID,
        itemId: "tool-2",
        input: null,
        output: url.includes(OTHER_ID) ? "Other tool detail" : "Reader tool detail",
        truncated: false,
      }));
    }));
    const props = {
      items: [toolItem],
      generation: 1,
      hasMore: false,
      loading: false,
      onLoadMore: vi.fn(),
      onStale: vi.fn(),
    };
    const { rerender } = render(<Timeline {...props} sessionId={SESSION_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("Reader tool detail")).toBeInTheDocument();
    rerender(<Timeline {...props} sessionId={OTHER_ID} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool detail" }));
    expect(await screen.findByText("Other tool detail")).toBeInTheDocument();
    expect(screen.queryByText("Reader tool detail")).toBeNull();
  });

  it.each(["tool", "directive"] as const)(
    "waits for a new generation before retrying stale %s detail",
    async (kind) => {
      const onStale = vi.fn();
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("generation=1")) {
          return Promise.resolve(
            json({ error: { code: "stale_generation", message: "stale" } }, 409),
          );
        }
        return Promise.resolve(json(kind === "tool"
          ? {
              generation: 2,
              sessionId: SESSION_ID,
              itemId: "tool-2",
              input: null,
              output: "Fresh tool detail",
              truncated: false,
            }
          : {
              generation: 2,
              sessionId: SESSION_ID,
              itemId: "directive-4",
              text: "Fresh directive",
              truncated: true,
            }));
      });
      vi.stubGlobal("fetch", fetchMock);
      const subject = (generation: number) => kind === "tool"
        ? <ToolItem
            item={toolItem}
            sessionId={SESSION_ID}
            generation={generation}
            onStale={onStale}
          />
        : <DirectiveItem
            item={directiveItem}
            sessionId={SESSION_ID}
            generation={generation}
            onStale={onStale}
          />;
      const { rerender } = render(subject(1));
      fireEvent.click(screen.getByRole("button", {
        name: kind === "tool" ? "Show tool detail" : "Show directive",
      }));
      await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
      rerender(subject(1));
      await act(async () => Promise.resolve());
      expect(fetchMock.mock.calls.filter(
        ([url]) => String(url).includes("generation=1"),
      )).toHaveLength(1);
      rerender(subject(2));
      expect(await screen.findByText(
        kind === "tool" ? "Fresh tool detail" : "Fresh directive",
      )).toBeInTheDocument();
      if (kind === "directive") {
        expect(screen.getByText("Directive was truncated for safe display.")).toBeInTheDocument();
      }
    },
  );

  it("loads directive lazily and isolates it by session", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(json({
        generation: 1,
        sessionId: url.includes(OTHER_ID) ? OTHER_ID : SESSION_ID,
        itemId: "directive-4",
        text: url.includes(OTHER_ID) ? "Other directive" : "Reader directive",
        truncated: false,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = {
      items: [directiveItem],
      generation: 1,
      hasMore: false,
      loading: false,
      onLoadMore: vi.fn(),
      onStale: vi.fn(),
    };
    const { rerender } = render(<Timeline {...props} sessionId={SESSION_ID} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/AGENTS.md instructions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    expect(await screen.findByText("Reader directive")).toBeInTheDocument();
    rerender(<Timeline {...props} sessionId={OTHER_ID} />);
    expect(screen.queryByText("Reader directive")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show directive" }));
    expect(await screen.findByText("Other directive")).toBeInTheDocument();
  });

  it("restarts from the first page when a generation becomes stale", async () => {
    let detailCalls = 0;
    let itemCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) {
        itemCalls += 1;
        if (itemCalls === 1) return Promise.resolve(json({ error: { code: "stale_generation", message: "stale" } }, 409));
        return Promise.resolve(json({ ...firstPage, generation: 2, hasMore: false }));
      }
      if (url.endsWith(SESSION_ID)) {
        detailCalls += 1;
        return Promise.resolve(json({ ...detailBody, generation: detailCalls }));
      }
      return Promise.resolve(json(listBody));
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(detailCalls).toBe(2);
    expect(itemCalls).toBe(2);
  });

  it("filters four technical event types locally and persists them in one show parameter", async () => {
    const allKindsPage: ItemPageResponse = {
      ...firstPage,
      items: [
        firstPage.items[0],
        directiveItem,
        toolItem,
        {
          kind: "internal",
          id: "internal-5",
          ordinal: 5,
          timestamp: null,
          eventType: "reasoning",
          summary: "Local reasoning summary",
        },
        {
          kind: "token",
          id: "token-7",
          ordinal: 7,
          timestamp: null,
          tokenUsage: { total: null, last: null },
        },
        {
          kind: "internal",
          id: "internal-6",
          ordinal: 6,
          timestamp: null,
          eventType: "local_filter",
          summary: "Local internal event",
        },
      ],
      nextAfterOrdinal: null,
      hasMore: false,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/items")) return Promise.resolve(json(allKindsPage));
      if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detailBody));
      return Promise.resolve(json(listBody));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Reader work/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
  
    const directiveToggle = await screen.findByRole("checkbox", { name: "directive" });
    const toolToggle = screen.getByRole("checkbox", { name: "tool" });
    const tokenToggle = screen.getByRole("checkbox", { name: "token" });
    const internalToggle = screen.getByRole("checkbox", { name: "internal" });
    const visibilityGroup = screen.getByRole("group", { name: "Timeline event visibility" });
    expect(within(visibilityGroup).getAllByRole("checkbox")).toEqual([
      directiveToggle,
      toolToggle,
      tokenToggle,
      internalToggle,
    ]);
    expect(directiveToggle).not.toBeChecked();
    expect(toolToggle).not.toBeChecked();
    expect(tokenToggle).not.toBeChecked();
    expect(internalToggle).not.toBeChecked();
    expect(screen.queryByText(/exec/)).toBeNull();
    expect(screen.queryByText("AGENTS.md instructions")).toBeNull();
    expect(screen.queryByText("Local reasoning summary")).toBeNull();
    expect(screen.queryByText(/Local internal event/)).toBeNull();
    expect(screen.queryByText("Token · 7")).toBeNull();
  
    const itemCalls = () => fetchMock.mock.calls.filter(
      ([url]) => String(url).includes(`/${SESSION_ID}/items`),
    );
    expect(itemCalls()).toHaveLength(1);
    expect(String(itemCalls()[0]![0])).toContain("limit=512");
    expect(String(itemCalls()[0]![0])).not.toContain("view=");
    expect(String(itemCalls()[0]![0])).not.toContain("includeTools=");
  
    fireEvent.click(directiveToggle);
    fireEvent.click(toolToggle);
    fireEvent.click(tokenToggle);
    fireEvent.click(internalToggle);
    expect(screen.getByText(/exec/)).toBeInTheDocument();
    expect(screen.getByText("AGENTS.md instructions")).toBeInTheDocument();
    expect(screen.getByText(/Local reasoning summary/)).toBeInTheDocument();
    expect(screen.getByText(/Local internal event/)).toBeInTheDocument();
    expect(screen.getByText("Token · 7")).toBeInTheDocument();
    expect(window.location.search).toContain(
      "show=directive,tool,token,internal",
    );
    expect(window.location.search).not.toMatch(
      /(?:tools|directive|reasoning|internal|token)=true/,
    );
    expect(directiveToggle).toBeChecked();
    expect(toolToggle).toBeChecked();
    expect(tokenToggle).toBeChecked();
    expect(internalToggle).toBeChecked();
    expect(itemCalls()).toHaveLength(1);
  
    window.history.pushState(
      null,
      "",
      `/?session=${SESSION_ID}&show=directive,token,reasoning,directive,unknown`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(toolToggle).not.toBeChecked());
    expect(directiveToggle).toBeChecked();
    expect(internalToggle).not.toBeChecked();
    expect(tokenToggle).toBeChecked();
    expect(screen.queryByText(/exec/)).toBeNull();
    expect(screen.getByText("AGENTS.md instructions")).toBeInTheDocument();
    expect(screen.queryByText("Local reasoning summary")).toBeNull();
    expect(screen.queryByText(/Local internal event/)).toBeNull();
    expect(screen.getByText("Token · 7")).toBeInTheDocument();
    expect(itemCalls()).toHaveLength(1);
  });
});
