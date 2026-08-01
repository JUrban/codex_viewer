// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackToTop } from "../../src/client/components/BackToTop";

describe("back to top", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setScrollY(0);
  });

  it("becomes available after scrolling down and returns to the top", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const { container } = render(<BackToTop />);

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("tabindex", "-1");

    act(() => {
      setScrollY(600);
      fireEvent.scroll(window);
    });

    const visibleButton = screen.getByRole("button", { name: "Back to top" });
    expect(visibleButton).toHaveClass("is-visible");
    expect(visibleButton).toHaveAttribute("aria-hidden", "false");
    fireEvent.click(visibleButton);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("avoids smooth scrolling when reduced motion is requested", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    setScrollY(600);
    render(<BackToTop />);

    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });
});

function setScrollY(value: number) {
  Object.defineProperty(window, "scrollY", { configurable: true, value });
}
