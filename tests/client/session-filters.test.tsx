// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { json, listBody } from "./session-browser.fixtures";

const STORAGE_KEY = "codex-sessions-reader.filters.v1";

describe("session filters", () => {
  it("orders project, date, and archive controls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("link", { name: /Reader work/ });

    screen.getByRole("combobox", { name: "Project" }).focus();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Date range" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("radio", { name: "All" })).toHaveFocus();
  });

  it("applies date drafts together and allows moving a range beyond its previous To", async () => {
    const listUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      listUrls.push(String(input));
      return Promise.resolve(json(listBody));
    }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("link", { name: /Reader work/ });
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

    fireEvent.change(to, { target: { value: "2026-07-10" } });
    expect(listUrls).toHaveLength(1);
    await user.click(apply);
    await waitFor(() => expect(listUrls).toHaveLength(2));
    let params = new URL(listUrls[1]!, window.location.origin).searchParams;
    expect(params.get("from")).toBe(new Date("2026-07-01T00:00:00").toISOString());
    expect(params.get("to")).toBe(new Date("2026-07-10T23:59:59.999").toISOString());
    expect(apply).toBeDisabled();

    await user.click(dateTrigger);
    fireEvent.change(from, { target: { value: "2026-07-15" } });
    expect(to).toHaveAttribute("min", "2026-07-15");
    expect(screen.getByRole("status")).toHaveTextContent("To must be on or after From");
    expect(apply).toBeDisabled();
    expect(listUrls).toHaveLength(2);

    fireEvent.change(to, { target: { value: "2026-07-20" } });
    expect(screen.queryByRole("status")).toBeNull();
    expect(apply).toBeEnabled();
    await user.click(apply);
    await waitFor(() => expect(listUrls).toHaveLength(3));
    params = new URL(listUrls[2]!, window.location.origin).searchParams;
    expect(params.get("from")).toBe(new Date("2026-07-15T00:00:00").toISOString());
    expect(params.get("to")).toBe(new Date("2026-07-20T23:59:59.999").toISOString());

    fireEvent.change(from, { target: { value: "" } });
    await user.click(apply);
    await waitFor(() => expect(listUrls).toHaveLength(4));
    params = new URL(listUrls[3]!, window.location.origin).searchParams;
    expect(params.has("from")).toBe(false);
    expect(params.get("to")).toBe(new Date("2026-07-20T23:59:59.999").toISOString());
  });

  it("opens the date range as a popover and closes it with Escape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(listBody));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("link", { name: /Reader work/ });
    const trigger = screen.getByRole("button", { name: "Date range" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Date range" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-07-01" },
    });
    expect(trigger).toHaveTextContent("From 2026-07-01");

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Date range");
    expect(screen.getByLabelText("From")).toHaveValue("");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Date range" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(trigger);
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-07-10" },
    });
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Date range");
    expect(screen.getByLabelText("To")).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists the applied archive scope across remounts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));

    const first = render(<App />);
    await screen.findByRole("link", { name: /Reader work/ });
    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
    await waitFor(() => expect(sessionStorage.getItem(STORAGE_KEY))
      .toContain('"state":"archived"'));

    first.unmount();
    render(<App />);
    expect(screen.getByRole("radio", { name: "Archived" })).toBeChecked();
  });

  it("restores valid query filters and safely rejects malformed storage", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
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
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(new URL(urls[0]!, window.location.origin).searchParams.get("project"))
      .toBe("/project/reader");
    view.unmount();

    sessionStorage.setItem(STORAGE_KEY, "{not-json");
    render(<App />);
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
  });

  it("restores calendar dates in positive UTC offset time zones", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
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
      project: "/project/reader",
      from: "2026-02-30",
      to: "",
      state: "all",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));

    render(<App />);

    expect(screen.getByLabelText("From")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
  });

  it("rejects stored filters containing unknown fields", () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      unexpected: "saved",
      project: "/project/reader",
      from: "2026-07-01",
      to: "2026-07-10",
      state: "all",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(listBody)));

    render(<App />);

    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    expect(screen.getByLabelText("From")).toHaveValue("");
  });

});
