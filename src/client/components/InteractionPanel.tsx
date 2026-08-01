import { useState, type KeyboardEvent } from "react";
import type { InteractionResponse } from "../../shared/api-contract";

interface InteractionPanelProps {
  interaction: InteractionResponse | null;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onSendMessage: (message: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onEscape: () => Promise<void>;
}

export function InteractionPanel({
  interaction,
  busy,
  error,
  onDismissError,
  onSendMessage,
  onInterrupt,
  onEscape,
}: InteractionPanelProps) {
  const [message, setMessage] = useState("");
  if (interaction == null || !interaction.supported) return null;

  const send = async () => {
    if (busy || !interaction.canSendMessage || message.trim().length === 0) return;
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

  return (
    <section className="interaction-panel" aria-label="Session interaction">
      <div className="interaction-heading">
        <div>
          <p className="eyebrow">Live interaction</p>
          <h3>{stateLabel(interaction.state)}</h3>
        </div>
        {!unbound && !disconnected
          ? <span className={`interaction-state ${interaction.state}`}>{interaction.state.replaceAll("_", " ")}</span>
          : null}
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
              <pre><code>{interaction.activation}</code></pre>
            </div>
          )
        : (
            <>
              <textarea
                aria-label="Message to agent"
                value={message}
                rows={4}
                maxLength={65_536}
                placeholder={interaction.canSendMessage
                  ? "Send a prompt… Enter for a new line, Shift+Enter to send"
                  : "Wait for the agent to become idle before sending a message"}
                disabled={busy || !interaction.canSendMessage}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={onKeyDown}
              />
              <div className="interaction-actions">
                <button
                  type="button"
                  disabled={busy || !interaction.canSendMessage || message.trim().length === 0}
                  onClick={() => void send().catch(() => undefined)}
                >
                  Send
                </button>
                <button
                  type="button"
                  disabled={busy || !interaction.canInterrupt}
                  onClick={() => void onInterrupt().catch(() => undefined)}
                >
                  Interrupt
                </button>
                <button
                  type="button"
                  disabled={busy || !interaction.canSendEscape}
                  onClick={() => void onEscape().catch(() => undefined)}
                >
                  Esc
                </button>
              </div>
            </>
          )}
    </section>
  );
}

function stateLabel(state: string): string {
  if (state === "unbound") return "Connect a tmux pane";
  if (state === "disconnected") return "Reconnect the tmux pane";
  if (state === "awaiting_user_input") return "Agent is awaiting input";
  if (state === "running") return "Agent is running";
  return "Send a message";
}
