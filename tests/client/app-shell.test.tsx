// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";
import { json } from "./session-browser.fixtures";

describe("application shell", () => {
  it("provides labelled browse landmarks and an actionable empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      listRevision: "llllllllllllllllllllllllllllllll",
      sessions: [], projects: [], partial: false, warnings: [],
    })));
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
    const query = screen.getByRole("searchbox", { name: "Find a session" });
    expect(query).toHaveAttribute("title", "Find a session");
    const from = screen.getByLabelText("From");
    expect(from).toHaveAttribute("title", "From");
    expect(screen.getByLabelText("To")).toHaveAttribute("title", "To");
    const project = screen.getByRole("combobox", { name: "Project" });
    const sessionState = screen.getByRole("group", { name: "Session state" });
    expect(project).not.toHaveAttribute("title");
    expect(sessionState).toHaveAttribute("title", "Session state");
    expect(await screen.findByRole("heading", { name: "No active sessions match" }))
      .toBeInTheDocument();
  });

  it("shows a useful API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      error: { code: "internal_error", message: "Catalog unavailable" },
    }, 500)));
    render(<App />);
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Could not load sessionsCatalog unavailable");
    const dismiss = screen.getByRole("button", { name: "Dismiss" });

    fireEvent.click(dismiss);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back safely when an error response has an invalid JSON shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 502)));

    render(<App />);

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Could not load sessionsRequest failed (502)");
  });
});
