// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/client/App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("application shell", () => {
  it("provides labelled browse landmarks and an actionable empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      generation: 1, sessions: [], projects: [], partial: false, warnings: [],
    })));
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Find a session" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "No sessions match" })).toBeInTheDocument();
  });

  it("shows a useful API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      error: { code: "internal_error", message: "Catalog unavailable" },
    }, 500)));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
