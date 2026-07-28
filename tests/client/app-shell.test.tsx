// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/client/App";

describe("application shell", () => {
  it("provides labelled navigation and timeline landmarks", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Fixture sessions" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Session timeline" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Find a session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show tool detail" })).toBeInTheDocument();
  });
});
