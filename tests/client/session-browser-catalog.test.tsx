// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import type { ListCursor, SessionListResponse } from "../../src/shared/api-contract";
import { baseSession, entry, json, listBody } from "./session-browser.fixtures";

describe("session catalog state", () => {
  it("accumulates cursor pages without duplicating sessions", async () => {
    const first = response([baseSession], "next-page");
    first.total = 2;
    const secondSession = { ...baseSession, id: "secondabcdefghijklmnopq", title: "Second" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json(response([baseSession, secondSession], null)));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("link", { name: /Reader work/ });
    fireEvent.click(screen.getByRole("button", { name: /Load more sessions/ }));
    expect(await screen.findByRole("link", { name: /Second/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Reader work/ })).toHaveLength(1);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("cursor=next-page");
  });

  it("aborts and ignores an obsolete query after filters change", async () => {
    let resolveInitial!: (value: Response) => void;
    const initial = new Promise<Response>((resolve) => { resolveInitial = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("archiveScope=archived")) return initial;
      return Promise.resolve(json(response([
        { ...baseSession, id: "archivedabcdefghijklmn", title: "Archived result", archived: true },
      ], null)));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
    expect(await screen.findByRole("link", { name: /Archived result/ })).toBeInTheDocument();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    resolveInitial(json(listBody));
    await Promise.resolve();
    expect(screen.queryByRole("link", { name: /Reader work/ })).toBeNull();
  });

  it("keeps the current list when a forced refresh fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(listBody))
      .mockResolvedValueOnce(json({ error: { code: "temporary_failure", message: "Refresh failed" } }, 503));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("link", { name: /Reader work/ });
    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reader work/ })).toBeInTheDocument();
  });

  it("persists and restores the three-state archive scope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));
    const view = render(<App />);
    await screen.findByRole("link", { name: /Reader work/ });
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    await waitFor(() => expect(sessionStorage.getItem("codex-sessions-reader.filters.v1"))
      .toContain('"state":"all"'));
    view.unmount();

    render(<App />);
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
  });

});

function response(
  sessions: typeof baseSession[],
  nextCursor: string | null,
): SessionListResponse {
  return {
    sessions: sessions.map(entry),
    projects: [{ project: "/project/reader", count: sessions.length }],
    total: sessions.length,
    nextCursor: nextCursor as ListCursor | null,
    partial: false,
    warnings: [],
  };
}
