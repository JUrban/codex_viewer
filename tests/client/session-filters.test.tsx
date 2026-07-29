// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { json, listBody } from "./session-browser.fixtures";

const STORAGE_KEY = "codex-sessions-reader.filters.v1";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("session filters", () => {
  it("orders filters by state, project, date, then query", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));
    render(<App />);
    await screen.findByRole("button", { name: /Reader work/ });

    const form = screen.getByRole("search");
    expect(Array.from(form.children)).toEqual([
      screen.getByRole("group", { name: "Session state" }),
      screen.getByRole("combobox", { name: "Project" }),
      screen.getByRole("button", { name: "Date range" }).closest(".date-grid"),
      screen.getByRole("searchbox", { name: "Find a session" }),
    ]);
  });

  it("keeps query as a draft until Enter and ignores duplicate submissions", async () => {
    const listUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      listUrls.push(String(input));
      return Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /Reader work/ });
    const search = screen.getByRole("searchbox");

    await user.type(search, "  reader  ");
    expect(listUrls).toHaveLength(1);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.location.search).toBe("");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(listUrls).toHaveLength(2));
    expect(new URL(listUrls[1]!, window.location.origin).searchParams.get("q"))
      .toBe("reader");
    expect(search).toHaveValue("reader");
    expect(sessionStorage.getItem(STORAGE_KEY)).toContain('"query":"reader"');

    await user.keyboard("{Enter}");
    expect(listUrls).toHaveLength(2);
  });

  it("applies date drafts together and allows moving a range beyond its previous To", async () => {
    const listUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      listUrls.push(String(input));
      return Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /Reader work/ });
    const dateTrigger = screen.getByRole("button", { name: "Date range" });
    await user.click(dateTrigger);
    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    const apply = screen.getByRole("button", { name: "Set" });

    from.focus();
    fireEvent.change(from, { target: { value: "2026-07-01" } });
    expect(listUrls).toHaveLength(1);
    expect(from).toHaveFocus();
    expect(to).not.toHaveFocus();
    expect(to).toHaveAttribute("min", "2026-07-01");
    expect(from).not.toHaveAttribute("max");
    expect(apply).toBeEnabled();

    await user.type(screen.getByRole("searchbox"), "reader");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(listUrls).toHaveLength(2));
    let params = new URL(listUrls[1]!, window.location.origin).searchParams;
    expect(params.get("q")).toBe("reader");
    expect(params.has("from")).toBe(false);

    fireEvent.change(to, { target: { value: "2026-07-10" } });
    expect(listUrls).toHaveLength(2);
    await user.click(apply);
    await waitFor(() => expect(listUrls).toHaveLength(3));
    params = new URL(listUrls[2]!, window.location.origin).searchParams;
    expect(params.get("from")).toBe(new Date("2026-07-01T00:00:00").toISOString());
    expect(params.get("to")).toBe(new Date("2026-07-10T23:59:59.999").toISOString());
    expect(apply).toBeDisabled();

    await user.click(dateTrigger);
    fireEvent.change(from, { target: { value: "2026-07-15" } });
    expect(to).toHaveAttribute("min", "2026-07-15");
    expect(screen.getByRole("status")).toHaveTextContent("To must be on or after From");
    expect(apply).toBeDisabled();
    expect(listUrls).toHaveLength(3);

    fireEvent.change(to, { target: { value: "2026-07-20" } });
    expect(screen.queryByRole("status")).toBeNull();
    expect(apply).toBeEnabled();
    await user.click(apply);
    await waitFor(() => expect(listUrls).toHaveLength(4));
    params = new URL(listUrls[3]!, window.location.origin).searchParams;
    expect(params.get("from")).toBe(new Date("2026-07-15T00:00:00").toISOString());
    expect(params.get("to")).toBe(new Date("2026-07-20T23:59:59.999").toISOString());

    fireEvent.change(from, { target: { value: "" } });
    await user.click(apply);
    await waitFor(() => expect(listUrls).toHaveLength(5));
    params = new URL(listUrls[4]!, window.location.origin).searchParams;
    expect(params.has("from")).toBe(false);
    expect(params.get("to")).toBe(new Date("2026-07-20T23:59:59.999").toISOString());
  });

  it("opens the date range as a popover and closes it with Escape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /Reader work/ });
    const trigger = screen.getByRole("button", { name: "Date range" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Date range" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Date range" })).toBeNull();
  });

  it("restores applied filters on remount and safely rejects malformed storage", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      query: "saved",
      project: "/project/reader",
      from: "2026-07-01",
      to: "2026-07-10",
      state: "all",
    }));
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(json(listBody));
    }));

    const view = render(<App />);
    expect(screen.getByRole("searchbox")).toHaveValue("saved");
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(new URL(urls[0]!, window.location.origin).searchParams.get("project"))
      .toBe("/project/reader");
    view.unmount();

    sessionStorage.setItem(STORAGE_KEY, "{not-json");
    render(<App />);
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Active" })).toBeChecked();
  });

  it("restores calendar dates in positive UTC offset time zones", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      query: "",
      project: "",
      from: "2026-07-01",
      to: "2026-07-10",
      state: "active",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));

    render(<App />);

    expect(screen.getByLabelText("From")).toHaveValue("2026-07-01");
    expect(screen.getByLabelText("To")).toHaveValue("2026-07-10");
  });

  it("rejects nonexistent calendar dates from storage", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      query: "saved",
      project: "/project/reader",
      from: "2026-02-30",
      to: "",
      state: "all",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));

    render(<App />);

    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByLabelText("From")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Active" })).toBeChecked();
  });

  it("removes legacy filter parameters while retaining timeline visibility", () => {
    window.history.replaceState(
      null,
      "",
      "/?q=legacy&from=2020-01-01&archiveScope=all&show=internal",
    );
    const replaceState = vi.spyOn(window.history, "replaceState");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));

    render(<App />);

    expect(window.location.search).toBe("?show=internal");
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Active" })).toBeChecked();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?show=internal");
  });
});
