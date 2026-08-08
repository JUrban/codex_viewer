import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  InteractionResponse,
  TerminalPreviewResponse,
} from "../../shared/api-contract";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/api-contract";

interface InteractionPanelProps {
  interaction: InteractionResponse | null;
  itemCount: number;
  updatedAt: string | null;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onSendMessage: (message: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onEscape: () => Promise<void>;
  preview: TerminalPreviewResponse | null;
  previewBusy: boolean;
  previewError: string | null;
  onDismissPreviewError: () => void;
  onPreviewTerminal: () => Promise<void>;
}

export function InteractionPanel({
  interaction,
  itemCount,
  updatedAt,
  busy,
  error,
  onDismissError,
  onSendMessage,
  onInterrupt,
  onEscape,
  preview,
  previewBusy,
  previewError,
  onDismissPreviewError,
  onPreviewTerminal,
}: InteractionPanelProps) {
  const [message, setMessage] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [previewExpanded, setPreviewExpanded] = useState(preview !== null);
  const previewContentId = useId();
  const previewContent = useRef<HTMLPreElement | null>(null);
  const scrollOnExpand = useRef(preview !== null);
  const focusOnExpand = useRef(false);
  const previewScrollTop = useRef<number | null>(null);
  const messageBytes = new TextEncoder().encode(message.replace(/\r\n?/g, "\n")).byteLength;
  const messageTooLarge = messageBytes > MAX_INTERACTION_MESSAGE_BYTES;
  useLayoutEffect(() => {
    if (!previewExpanded || preview === null) return;
    const content = previewContent.current;
    if (content === null) {
      focusOnExpand.current = false;
      return;
    }
    if (scrollOnExpand.current) {
      content.scrollTop = content.scrollHeight;
      scrollOnExpand.current = false;
      previewScrollTop.current = null;
    } else if (previewScrollTop.current !== null) {
      content.scrollTop = previewScrollTop.current;
      previewScrollTop.current = null;
    }
    if (focusOnExpand.current) {
      content.focus({ preventScroll: true });
      focusOnExpand.current = false;
    }
  }, [preview, previewExpanded]);
  if (interaction == null || !interaction.supported) return null;

  const send = async () => {
    if (busy || message.trim().length === 0 || messageTooLarge) return;
    await onSendMessage(message);
    setMessage("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send().catch(() => undefined);
  };
  const disconnected = interaction.state === "disconnected";
  const unbound = interaction.state === "unbound";
  const copyActivation = async () => {
    try {
      await navigator.clipboard.writeText(interaction.activation);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const togglePreview = async () => {
    if (preview === null) {
      scrollOnExpand.current = true;
      await onPreviewTerminal();
      focusOnExpand.current = true;
      setPreviewExpanded(true);
      return;
    }
    setPreviewExpanded((expanded) => {
      if (!expanded) {
        scrollOnExpand.current = true;
        focusOnExpand.current = true;
      }
      return !expanded;
    });
  };
  const refreshPreview = async () => {
    previewScrollTop.current = previewContent.current?.scrollTop ?? null;
    await onPreviewTerminal();
  };

  return (
    <section className="interaction-panel" aria-label="Session interaction">
      <div className="interaction-heading">
        <div>
          <p className="eyebrow">Live interaction</p>
        </div>
      </div>
      {error
        ? (
            <div className="interaction-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={onDismissError} aria-label="Dismiss interaction error">×</button>
            </div>
          )
        : null}
      {unbound || disconnected
        ? (
            <div className="interaction-activation">
              <p>{disconnected
                ? "The previous tmux target is unavailable. Run the activation command again in the agent pane."
                : "Run this command in the agent to connect its current tmux pane:"}</p>
              <div className="activation-command">
                <pre><code>{interaction.activation}</code></pre>
                <button
                  type="button"
                  className="copy-activation"
                  onClick={() => void copyActivation()}
                >
                  {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
                </button>
              </div>
            </div>
          )
        : (
            <>
              <section className="terminal-preview" aria-label="Terminal preview">
                <div className="terminal-preview-header">
                  <button
                    type="button"
                    className="terminal-preview-toggle"
                    aria-expanded={preview !== null && previewExpanded}
                    aria-controls={preview !== null ? previewContentId : undefined}
                    disabled={preview === null && previewBusy}
                    onClick={() => void togglePreview().catch(() => undefined)}
                  >
                    <span className="terminal-preview-mark" aria-hidden="true">
                      {preview !== null && previewExpanded ? "▾" : "▸"}
                    </span>
                    <span>Terminal preview</span>
                    {preview === null && previewBusy
                      ? <span className="terminal-preview-status">Capturing…</span>
                      : null}
                  </button>
                  {preview
                    ? (
                        <div className="terminal-preview-meta">
                          <time dateTime={preview.capturedAt}>
                            {new Date(preview.capturedAt).toLocaleTimeString()}
                          </time>
                          <button
                            type="button"
                            className={previewBusy ? "is-active" : undefined}
                            aria-label="Refresh terminal preview"
                            aria-busy={previewBusy}
                            disabled={previewBusy}
                            onClick={() => void refreshPreview().catch(() => undefined)}
                          >
                            <span
                              className={`terminal-preview-refresh-icon${previewBusy ? " is-spinning" : ""}`}
                              aria-hidden="true"
                            >↻</span>
                          </button>
                        </div>
                      )
                    : null}
                </div>
                {previewError
                  ? (
                      <div className="interaction-error terminal-preview-error" role="alert">
                        <span>{previewError}</span>
                        <button
                          type="button"
                          onClick={onDismissPreviewError}
                          aria-label="Dismiss terminal preview error"
                        >×</button>
                      </div>
                    )
                  : null}
                {preview && previewExpanded
                  ? (
                      <div id={previewContentId} className="terminal-preview-body">
                        {preview.truncated
                          ? <p className="terminal-preview-notice">Older terminal output was truncated.</p>
                          : null}
                        {preview.content.length > 0
                          ? (
                              <pre
                                key={preview.capturedAt}
                                ref={previewContent}
                                aria-label="Terminal preview content"
                                tabIndex={0}
                              >
                                {preview.content}
                              </pre>
                            )
                          : <p className="terminal-preview-empty">The terminal pane is empty.</p>}
                      </div>
                    )
                  : null}
              </section>
              <div className="interaction-composer">
                <textarea
                  aria-label="Message to agent"
                  value={message}
                  rows={3}
                  maxLength={MAX_INTERACTION_MESSAGE_BYTES}
                  placeholder="Send a prompt… Enter for a new line, Shift+Enter to send"
                  disabled={busy}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={onKeyDown}
                />
                {messageTooLarge
                  ? (
                      <p className="interaction-message-limit" role="alert">
                        Message is {messageBytes.toLocaleString()} UTF-8 bytes; the limit is{" "}
                        {MAX_INTERACTION_MESSAGE_BYTES.toLocaleString()} bytes.
                      </p>
                    )
                  : null}
                <div className="interaction-actions">
                  <button
                    type="button"
                    className="interaction-send"
                    disabled={busy || message.trim().length === 0 || messageTooLarge}
                    onClick={() => void send().catch(() => undefined)}
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onInterrupt().catch(() => undefined)}
                  >
                    Ctrl-C
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onEscape().catch(() => undefined)}
                  >
                    Esc
                  </button>
                </div>
              </div>
            </>
          )}
      <p className="interaction-summary">{sessionSummary(itemCount, updatedAt)}</p>
    </section>
  );
}

function sessionSummary(itemCount: number, updatedAt: string | null): string {
  const eventLabel = `${itemCount} ${itemCount === 1 ? "event" : "events"}`;
  if (updatedAt === null) return `${eventLabel} · Update time unavailable`;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.valueOf())) return `${eventLabel} · Update time unavailable`;
  return `${eventLabel} · Updated ${date.toLocaleTimeString(undefined, { timeStyle: "medium" })}`;
}
