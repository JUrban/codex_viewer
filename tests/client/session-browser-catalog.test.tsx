// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import type { ListCursor, SessionListResponse } from "../../src/shared/api-contract";
import { baseSession, json, listBody } from "./session-browser.fixtures";
import { installIntersectionObserver, intersectLatest } from "./intersection-observer";

describe("session catalog state", () => {
  it("accumulates cursor pages without duplicating sessions", async () => {
    installIntersectionObserver();
    const first = response([baseSession], "next-page");
    first.total = 2;
    const secondSession = { ...baseSession, id: "secondabcdefghijklmnopq", title: "Second" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json(response([baseSession, secondSession], null)));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("link", { name: /Reader work/ });
    expect(screen.queryByRole("button", { name: /Load more sessions/ })).not.toBeInTheDocument();
    intersectLatest();
    expect(await screen.findByRole("link", { name: /Second/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Reader work/ })).toHaveLength(1);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("cursor=next-page");
  });

  it("keeps paging when the selected state has no match on the current page", async () => {
    sessionStorage.setItem("codex-sessions-reader.filters.v1", JSON.stringify({
      project: "",
      from: "",
      to: "",
      state: "archived",
    }));
    installIntersectionObserver();
    const first = response([baseSession], "archived-page");
    first.total = 2;
    const archived = {
      ...baseSession,
      id: "archivedpageabcdefghijkl",
      title: "Paged archive",
      archived: true,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json(response([archived], null)));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("No archived sessions match")).not.toBeInTheDocument();
    expect(document.querySelector(".infinite-scroll-sentinel")).toBeInTheDocument();

    await flushMicrotasks();
    intersectLatest();
    expect(await screen.findByRole("link", { name: /Paged archive/ })).toBeInTheDocument();
    expect(screen.getByText("Sessions · 1")).toBeInTheDocument();
  });

  it("shows catalog diagnostics and replaces them with the latest page or refresh", async () => {
    installIntersectionObserver();
    const first = response([baseSession], "next-page", "First diagnostic");
    first.total = 2;
    const secondSession = {
      ...baseSession,
      id: "secondabcdefghijklmnopq",
      title: "Second",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json(response(
        [baseSession, secondSession],
        null,
        "Page diagnostic",
      )))
      .mockResolvedValueOnce(json(response(
        [baseSession, secondSession],
        null,
        "Refresh diagnostic",
      )));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const notice = await screen.findByLabelText("Catalog diagnostics");
    expect(notice).toHaveTextContent("First diagnostic");
    intersectLatest();
    await waitFor(() => {
      expect(screen.getByLabelText("Catalog diagnostics"))
        .toHaveTextContent("Page diagnostic");
    });
    expect(screen.queryByText("First diagnostic")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Catalog diagnostics"))
        .toHaveTextContent("Refresh diagnostic");
    });
    expect(screen.queryByText("Page diagnostic")).not.toBeInTheDocument();
  });

  it("does not render an empty catalog diagnostic notice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));
    render(<App />);
    await screen.findByRole("link", { name: /Reader work/ });
    expect(screen.queryByLabelText("Catalog diagnostics")).not.toBeInTheDocument();
  });

  it("backs off retryable automatic page failures", async () => {
    const first = response([baseSession], "retry-page");
    first.total = 2;
    const secondSession = { ...baseSession, id: "retryabcdefghijklmnopqr", title: "Retried" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json({ error: { code: "busy", message: "Busy" } }, 503))
      .mockResolvedValueOnce(json(response([secondSession], null)));
    vi.stubGlobal("fetch", fetchMock);
    installIntersectionObserver();
    render(<App />);
    await screen.findByRole("link", { name: /Reader work/ });

    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    intersectLatest();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Busy")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("link", { name: /Retried/ })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("stops automatic pagination on a terminal page error", async () => {
    const first = response([baseSession], "terminal-page");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(first))
      .mockResolvedValueOnce(json({ error: { code: "invalid_query", message: "Stop paging" } }, 400));
    vi.stubGlobal("fetch", fetchMock);
    installIntersectionObserver();
    render(<App />);
    await screen.findByRole("link", { name: /Reader work/ });

    intersectLatest();
    expect(await screen.findByText("Stop paging")).toBeInTheDocument();
    intersectLatest();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters loaded sessions by state without issuing another request", async () => {
    const archived = {
      ...baseSession,
      id: "archivedabcdefghijklmn",
      title: "Archived result",
      archived: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(json(response([baseSession, archived], null)));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("link", { name: /Reader work/ });
    expect(screen.getByRole("link", { name: /Archived result/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
    expect(screen.getByRole("link", { name: /Archived result/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Reader work/ })).not.toBeInTheDocument();
    expect(screen.getByText("Sessions · 1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("archiveScope");
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

  it("keeps a selected project visible when the query has no matching sessions", async () => {
    sessionStorage.setItem("codex-sessions-reader.filters.v1", JSON.stringify({
      project: "/project/empty",
      from: "",
      to: "",
      state: "active",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      ...response([], null),
      projects: [],
    })));

    render(<App />);

    await screen.findByText("No active sessions match");
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("/project/empty");
    expect(screen.getByRole("option", { name: "/project/empty (0)" })).toBeInTheDocument();
  });

});

async function flushMicrotasks(turns = 6): Promise<void> {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) await Promise.resolve();
  });
}

function response(
  sessions: typeof baseSession[],
  nextCursor: string | null,
  diagnosticMessage?: string,
): SessionListResponse {
  return {
    sessions,
    projects: [{ project: "/project/reader", count: sessions.length }],
    total: sessions.length,
    nextCursor: nextCursor as ListCursor | null,
    diagnostics: diagnosticMessage === undefined
      ? []
      : [{
          code: "catalog_test",
          severity: "warning",
          message: diagnosticMessage,
          ordinal: null,
        }],
  };
}
