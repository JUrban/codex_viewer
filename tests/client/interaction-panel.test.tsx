// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InteractionPanel } from "../../src/client/components/InteractionPanel";
import type { InteractionResponse } from "../../src/shared/api-contract";

const activation = "! printf 'CODEX_VIEWER_TMUX_BIND_V1\\n%s\\n%s\\n' \"$TMUX\" \"$TMUX_PANE\"";

function interaction(
  state: "unbound" | "disconnected" | "idle" | "running" | "awaiting_user_input",
): InteractionResponse {
  return {
    supported: true,
    state,
    activation,
    canSendMessage: state === "idle",
    canInterrupt: state === "running" || state === "awaiting_user_input",
    canSendEscape: state !== "unbound" && state !== "disconnected",
  };
}

function props(value: InteractionResponse | null) {
  return {
    interaction: value,
    busy: false,
    error: null,
    onDismissError: vi.fn(),
    onSendMessage: vi.fn().mockResolvedValue(undefined),
    onInterrupt: vi.fn().mockResolvedValue(undefined),
    onEscape: vi.fn().mockResolvedValue(undefined),
  };
}

describe("interaction panel", () => {
  it("keeps unsupported sessions as a pure viewer", () => {
    const { container, rerender } = render(<InteractionPanel {...props(null)} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<InteractionPanel {...props({ supported: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows activation and reconnection guidance", () => {
    const { rerender } = render(<InteractionPanel {...props(interaction("unbound"))} />);
    expect(screen.getByRole("heading", { name: "Connect a tmux pane" })).toBeInTheDocument();
    expect(screen.getByText(activation)).toBeInTheDocument();
    rerender(<InteractionPanel {...props(interaction("disconnected"))} />);
    expect(screen.getByRole("heading", { name: "Reconnect the tmux pane" })).toBeInTheDocument();
    expect(screen.getByText(/previous tmux target is unavailable/i)).toBeInTheDocument();
  });

  it("copies the activation command", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<InteractionPanel {...props(interaction("unbound"))} />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith(activation);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("inserts a newline on Enter, sends on Shift+Enter, and clears after success", async () => {
    const handlers = props(interaction("idle"));
    const user = userEvent.setup();
    render(<InteractionPanel {...handlers} />);
    const textarea = screen.getByRole("textbox", { name: "Message to agent" });
    await user.type(textarea, "line one{enter}line two");
    expect(textarea).toHaveValue("line one\nline two");
    expect(handlers.onSendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(handlers.onSendMessage).toHaveBeenCalledWith("line one\nline two");
    expect(await screen.findByRole("textbox", { name: "Message to agent" })).toHaveValue("");
  });

  it("enables controls according to idle, running, and awaiting-input states", () => {
    const handlers = props(interaction("running"));
    const { rerender } = render(<InteractionPanel {...handlers} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();

    rerender(<InteractionPanel {...props(interaction("awaiting_user_input"))} />);
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeEnabled();

    rerender(<InteractionPanel {...props(interaction("idle"))} />);
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
  });
});
