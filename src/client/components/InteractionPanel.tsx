import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  InteractionKey,
  InteractionResponse,
  TerminalPreviewResponse,
} from "../../shared/api-contract";
import { MAX_INTERACTION_MESSAGE_BYTES } from "../../shared/api-contract";

interface InteractionPanelProps {
  interaction: InteractionResponse | null;
  itemCount: number;
  updatedAt: string | null;
  interactionBusy: boolean;
  error: string | null;
  onDismissError: () => void;
  onSendMessage: (message: string) => Promise<void>;
  onSendKeys: (keys: readonly InteractionKey[]) => Promise<void>;
  preview: TerminalPreviewResponse | null;
  previewBusy: boolean;
  previewError: string | null;
  onDismissPreviewError: () => void;
  onPreviewTerminal: () => Promise<void>;
  onCancelPreviewTerminal: () => void;
}

export function InteractionPanel({
  interaction,
  itemCount,
  updatedAt,
  interactionBusy,
  error,
  onDismissError,
  onSendMessage,
  onSendKeys,
  preview,
  previewBusy,
  previewError,
  onDismissPreviewError,
  onPreviewTerminal,
  onCancelPreviewTerminal,
}: InteractionPanelProps) {
  const [message, setMessage] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [previewExpanded, setPreviewExpanded] = useState(preview !== null);
  const [previewAutoRefresh, setPreviewAutoRefresh] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const previewContentId = useId();
  const previewAutoRefreshLabelId = useId();
  const previewContent = useRef<HTMLPreElement | null>(null);
  const scrollOnExpand = useRef(preview !== null);
  const focusOnExpand = useRef(false);
  const messageBytes = new TextEncoder().encode(message.replace(/\r\n?/g, "\n")).byteLength;
  const messageTooLarge = messageBytes > MAX_INTERACTION_MESSAGE_BYTES;
  const messageIsBlank = message.trim().length === 0;
  const previewConnected = interaction?.supported === true && interaction.state === "connected";
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
    }
    if (focusOnExpand.current) {
      content.focus({ preventScroll: true });
      focusOnExpand.current = false;
    }
  }, [preview, previewExpanded]);
  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  useEffect(() => {
    if (!previewConnected || !previewExpanded || !pageVisible) {
      onCancelPreviewTerminal();
      return;
    }
    if (!previewAutoRefresh) {
      return () => onCancelPreviewTerminal();
    }

    let cancelled = false;
    let timer: number | null = null;
    const capture = async () => {
      try {
        await onPreviewTerminal();
      } catch {
        // Keep the last successful preview and retry on the next cycle.
      }
      if (!cancelled) timer = window.setTimeout(() => void capture(), 1_000);
    };
    void capture();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      onCancelPreviewTerminal();
    };
  }, [
    onCancelPreviewTerminal,
    onPreviewTerminal,
    pageVisible,
    previewAutoRefresh,
    previewConnected,
    previewExpanded,
  ]);
  if (interaction == null || !interaction.supported) return null;

  const send = async () => {
    if (interactionBusy || messageIsBlank || messageTooLarge) return;
    await onSendMessage(message);
    setMessage("");
  };
  const sendKeys = (keys: readonly InteractionKey[]) => {
    if (interactionBusy) return;
    void onSendKeys(keys).catch(() => undefined);
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
  const togglePreview = () => {
    if (previewExpanded) {
      setPreviewExpanded(false);
      return;
    }
    scrollOnExpand.current = true;
    focusOnExpand.current = true;
    setPreviewExpanded(true);
    if (!previewAutoRefresh && pageVisible) {
      void onPreviewTerminal().catch(() => undefined);
    }
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
                    aria-expanded={previewExpanded}
                    aria-controls={previewContentId}
                    onClick={togglePreview}
                  >
                    <span className="terminal-preview-mark" aria-hidden="true">
                      {preview !== null && previewExpanded ? "▾" : "▸"}
                    </span>
                    <span>Terminal preview</span>
                    {preview === null && previewBusy
                      ? <span className="terminal-preview-status">Capturing…</span>
                      : null}
                  </button>
                  <div className="terminal-preview-meta">
                    <span className="terminal-preview-auto-label" id={previewAutoRefreshLabelId}>
                      Auto refresh
                    </span>
                    <button
                      type="button"
                      className="auto-refresh-switch terminal-preview-auto-switch"
                      role="switch"
                      aria-checked={previewAutoRefresh}
                      aria-labelledby={previewAutoRefreshLabelId}
                      onClick={() => setPreviewAutoRefresh((enabled) => !enabled)}
                    >
                      <span className="auto-refresh-thumb" aria-hidden="true" />
                    </button>
                  </div>
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
                {previewExpanded
                  ? (
                      <div id={previewContentId} className="terminal-preview-body">
                        {preview?.truncated
                          ? <p className="terminal-preview-notice">Terminal output exceeded the preview limit; the beginning was omitted.</p>
                          : null}
                        {preview && preview.content.length > 0
                          ? (
                              <pre
                                ref={previewContent}
                                aria-label="Terminal preview content"
                                tabIndex={0}
                              >
                                {preview.content}
                              </pre>
                            )
                          : (
                              <p className="terminal-preview-empty">
                                {preview === null && previewBusy
                                  ? "Capturing terminal pane…"
                                  : preview === null
                                    ? "Terminal preview unavailable."
                                    : "The terminal pane is empty."}
                              </p>
                            )}
                        <div className="terminal-keypad" role="group" aria-label="Terminal controls">
                          {TERMINAL_CONTROL_KEYS.map(({ key, label, glyph }) => (
                            <button
                              key={key}
                              type="button"
                              className={`terminal-key terminal-key-${key}`}
                              aria-label={label}
                              aria-disabled={interactionBusy}
                              onClick={() => sendKeys([key])}
                            >
                              <span aria-hidden="true">{glyph}</span>
                            </button>
                          ))}
                        </div>
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
                    disabled={messageIsBlank || messageTooLarge}
                    aria-disabled={interactionBusy}
                    onClick={() => void send().catch(() => undefined)}
                  >
                    Send
                  </button>
                  <button
                    type="button"
                    aria-disabled={interactionBusy}
                    onClick={() => sendKeys(["interrupt"])}
                  >
                    Interrupt
                  </button>
                  <button
                    type="button"
                    aria-disabled={interactionBusy}
                    onClick={() => sendKeys(["plan"])}
                  >
                    Plan
                  </button>
                </div>
              </div>
            </>
          )}
      <p className="interaction-summary">{sessionSummary(itemCount, updatedAt)}</p>
    </section>
  );
}

const TERMINAL_CONTROL_KEYS: ReadonlyArray<{
  readonly key: Extract<InteractionKey, "up" | "down" | "left" | "right" | "enter">;
  readonly label: string;
  readonly glyph: string;
}> = [
  { key: "up", label: "Up", glyph: "↑" },
  { key: "left", label: "Left", glyph: "←" },
  { key: "enter", label: "Enter", glyph: "↵" },
  { key: "right", label: "Right", glyph: "→" },
  { key: "down", label: "Down", glyph: "↓" },
];

function sessionSummary(itemCount: number, updatedAt: string | null): string {
  const eventLabel = `${itemCount} ${itemCount === 1 ? "event" : "events"}`;
  if (updatedAt === null) return `${eventLabel} · Update time unavailable`;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.valueOf())) return `${eventLabel} · Update time unavailable`;
  return `${eventLabel} · Updated ${date.toLocaleTimeString(undefined, { timeStyle: "medium" })}`;
}
