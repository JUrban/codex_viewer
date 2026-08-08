// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InteractionPanel } from "../../src/client/components/InteractionPanel";
import type { InteractionResponse } from "../../src/shared/api-contract";

const activation = "! printf 'CODEX_VIEWER_TMUX_BIND_V1\\n%s\\n%s\\n' \"$TMUX\" \"$TMUX_PANE\"";

function interaction(
  state: "unbound" | "disconnected" | "connected",
): InteractionResponse {
  return {
    supported: true,
    state,
    activation,
  };
}

function props(value: InteractionResponse | null) {
  return {
    interaction: value,
    itemCount: 12,
    updatedAt: "2026-08-08T12:00:00.000Z",
    busy: false,
    error: null,
    onDismissError: vi.fn(),
    onSendMessage: vi.fn().mockResolvedValue(undefined),
    onInterrupt: vi.fn().mockResolvedValue(undefined),
    onEscape: vi.fn().mockResolvedValue(undefined),
    preview: null,
    previewBusy: false,
    previewError: null,
    onDismissPreviewError: vi.fn(),
    onPreviewTerminal: vi.fn().mockResolvedValue(undefined),
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
    const updatedAt = "2026-08-08T12:00:00.000Z";
    const localTime = new Date(updatedAt).toLocaleTimeString(undefined, { timeStyle: "medium" });
    const { rerender } = render(
      <InteractionPanel
        {...props(interaction("unbound"))}
        itemCount={12}
        updatedAt={updatedAt}
      />,
    );
    expect(screen.getByText(activation)).toBeInTheDocument();
    expect(screen.getByText(`12 events · Updated ${localTime}`)).toBeInTheDocument();
    rerender(
      <InteractionPanel
        {...props(interaction("disconnected"))}
        itemCount={12}
        updatedAt={updatedAt}
      />,
    );
    expect(screen.getByText(/previous tmux target is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(`12 events · Updated ${localTime}`)).toBeInTheDocument();
  });

  it("shows the event count and local update time while connected", () => {
    const updatedAt = "2026-08-08T12:00:00.000Z";
    const localTime = new Date(updatedAt).toLocaleTimeString(undefined, { timeStyle: "medium" });
    render(<InteractionPanel {...props(interaction("connected"))} itemCount={12} updatedAt={updatedAt} />);

    const summary = screen.getByText(`12 events · Updated ${localTime}`);
    const preview = screen.getByRole("region", { name: "Terminal preview" });
    const prompt = screen.getByRole("textbox", { name: "Message to agent" });
    const lastAction = screen.getByRole("button", { name: "Esc" });
    expect(summary).toBeInTheDocument();
    expect(preview.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lastAction.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(preview.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses a singular event label and falls back when the update time is unavailable", () => {
    const { rerender } = render(
      <InteractionPanel {...props(interaction("connected"))} itemCount={1} updatedAt={null} />,
    );
    expect(screen.getByText("1 event · Update time unavailable")).toBeInTheDocument();

    rerender(
      <InteractionPanel {...props(interaction("connected"))} itemCount={0} updatedAt="not-a-time" />,
    );
    expect(screen.getByText("0 events · Update time unavailable")).toBeInTheDocument();
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
    const handlers = props(interaction("connected"));
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

  it("dispatches interaction controls and disables them while busy", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    expect(screen.getByText(/12 events · Updated/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ctrl-C" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Terminal preview" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Ctrl-C" }));
    await user.click(screen.getByRole("button", { name: "Esc" }));
    expect(handlers.onInterrupt).toHaveBeenCalledTimes(1);
    expect(handlers.onEscape).toHaveBeenCalledTimes(1);

    rerender(<InteractionPanel {...props(interaction("connected"))} busy />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ctrl-C" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
  });

  it("loads from the unified header and opens at the bottom", async () => {
    const handlers = props(interaction("connected"));
    const captured = {
      content: "first\nlatest",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
    };
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(480);
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);

    const header = screen.getByRole("button", { name: "Terminal preview" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);

    rerender(<InteractionPanel {...handlers} preview={captured} />);
    expect(screen.getByRole("button", { name: "Terminal preview" }))
      .toHaveAttribute("aria-expanded", "true");
    const content = screen.getByLabelText("Terminal preview content");
    expect(content).toHaveAttribute("tabindex", "0");
    expect(content).toHaveFocus();
    expect(content.scrollTop).toBe(480);
    scrollHeight.mockRestore();
  });

  it("folds, reopens at the bottom, refreshes in place, and renders text safely", async () => {
    const handlers = {
      ...props(interaction("connected")),
      preview: {
        content: "\u001b[31mplain text<img src=x onerror=alert(1)><script>alert(2)</script>",
        truncated: true,
        capturedAt: "2026-08-08T12:00:00.000Z",
      },
    };
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(640);
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);

    const content = screen.getByLabelText("Terminal preview content");
    expect(content).not.toHaveFocus();
    expect(content).toHaveTextContent(
      "plain text<img src=x onerror=alert(1)><script>alert(2)</script>",
    );
    expect(content.querySelector("img")).toBeNull();
    expect(content.querySelector("script")).toBeNull();
    expect(screen.getByText(/older terminal output was truncated/i)).toBeInTheDocument();
    const header = screen.getByRole("button", { name: "Terminal preview" });
    await user.click(header);
    expect(screen.queryByLabelText("Terminal preview content")).not.toBeInTheDocument();
    await user.click(header);
    expect(screen.getByLabelText("Terminal preview content")).toHaveFocus();
    expect(screen.getByLabelText("Terminal preview content").scrollTop).toBe(640);

    const reopened = screen.getByLabelText("Terminal preview content");
    reopened.scrollTop = 120;
    const refreshButton = screen.getByRole("button", { name: "Refresh terminal preview" });
    await user.click(refreshButton);
    expect(refreshButton).toHaveFocus();
    expect(handlers.onPreviewTerminal).toHaveBeenCalledTimes(1);
    const refreshedPreview = {
      ...handlers.preview,
      content: "fresh terminal output",
      capturedAt: "2026-08-08T12:00:01.000Z",
    };
    rerender(<InteractionPanel {...handlers} preview={refreshedPreview} />);
    const refreshed = screen.getByLabelText("Terminal preview content");
    expect(refreshed).toHaveTextContent("fresh terminal output");
    expect(refreshed).not.toHaveFocus();
    expect(refreshButton).toHaveFocus();
    expect(refreshed.scrollTop).toBe(120);
    scrollHeight.mockRestore();
  });

  it("keeps focus on the toggle when an expanded preview is empty", async () => {
    const handlers = props(interaction("connected"));
    const user = userEvent.setup();
    const { rerender } = render(<InteractionPanel {...handlers} />);
    const header = screen.getByRole("button", { name: "Terminal preview" });

    await user.click(header);
    rerender(<InteractionPanel
      {...handlers}
      preview={{ content: "", truncated: false, capturedAt: "2026-08-08T12:00:00.000Z" }}
    />);

    expect(header).toHaveFocus();
    expect(screen.queryByLabelText("Terminal preview content")).not.toBeInTheDocument();
    expect(screen.getByText("The terminal pane is empty.")).toBeInTheDocument();
  });

  it("keeps the refresh glyph and exposes its busy state", () => {
    const captured = {
      content: "output",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
    };
    const handlers = props(interaction("connected"));
    const { rerender } = render(<InteractionPanel {...handlers} preview={captured} />);
    const refresh = screen.getByRole("button", { name: "Refresh terminal preview" });
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveAttribute("aria-busy", "false");
    expect(refresh).toHaveTextContent("↻");
    expect(refresh.firstElementChild).not.toHaveClass("is-spinning");

    rerender(<InteractionPanel {...handlers} preview={captured} previewBusy />);
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(refresh).toHaveClass("is-active");
    expect(refresh).toHaveTextContent("↻");
    expect(refresh.firstElementChild).toHaveClass("is-spinning");
  });
});
