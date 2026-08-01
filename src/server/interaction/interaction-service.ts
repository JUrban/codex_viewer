import type { InteractionResponse } from "../../shared/api-contract.js";
import type { InteractionBindingAttempt } from "../domain/session-domain.js";
import type {
  InteractionSessionSnapshot,
  SessionRepository,
} from "../repository/session-repository.js";
import {
  TmuxInteractionError,
  TmuxInteractionService,
  type TmuxBinding,
} from "./tmux-service.js";

export type InteractionAction = "message" | "interrupt" | "escape";

export class SessionInteractionError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "interaction_not_supported"
      | "interaction_not_connected"
      | "interaction_state_conflict"
      | "operation_result_unknown"
      | "interaction_failed",
    message: string,
  ) {
    super(message);
    this.name = "SessionInteractionError";
  }
}

interface CachedBinding {
  readonly attempt: InteractionBindingAttempt & { readonly valid: true };
  readonly binding: TmuxBinding;
}

export class SessionInteractionService {
  readonly #bindings = new Map<string, CachedBinding>();

  constructor(
    private readonly repository: SessionRepository,
    private readonly enabled: boolean,
    private readonly tmux = new TmuxInteractionService(),
  ) {}

  async describe(sessionId: string): Promise<InteractionResponse | null> {
    const session = await this.repository.getInteractionSession(sessionId);
    if (session === null) return null;
    if (!this.#supported(session)) return { supported: false };
    const interaction = session.interaction!;
    const attempt = interaction.bindingAttempt;
    if (attempt === null) return response(interaction.activation, "unbound");
    if (!attempt.valid) {
      this.#bindings.delete(sessionId);
      return response(interaction.activation, "disconnected");
    }
    try {
      const binding = await this.tmux.connect(attempt);
      this.#bindings.set(sessionId, { attempt, binding });
      return response(interaction.activation, interaction.state);
    } catch {
      this.#bindings.delete(sessionId);
      return response(interaction.activation, "disconnected");
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const { binding } = await this.#resolve(sessionId, "message");
    await this.#perform(sessionId, () => this.tmux.sendMessage(binding, message));
  }

  async interrupt(sessionId: string): Promise<void> {
    const { binding } = await this.#resolve(sessionId, "interrupt");
    await this.#perform(sessionId, () => this.tmux.sendInterrupt(binding));
  }

  async escape(sessionId: string): Promise<void> {
    const { binding } = await this.#resolve(sessionId, "escape");
    await this.#perform(sessionId, () => this.tmux.sendEscape(binding));
  }

  async #resolve(sessionId: string, action: InteractionAction): Promise<CachedBinding> {
    const session = await this.repository.getInteractionSession(sessionId);
    if (session === null) {
      throw new SessionInteractionError("session_not_found", "Session not found");
    }
    if (!this.#supported(session)) {
      throw new SessionInteractionError(
        "interaction_not_supported",
        "Interaction is not supported for this session",
      );
    }
    const interaction = session.interaction!;
    if (
      (action === "message" && interaction.state !== "idle") ||
      (action === "interrupt" && interaction.state === "idle")
    ) {
      throw new SessionInteractionError(
        "interaction_state_conflict",
        `The ${action} action is not available while the agent is ${interaction.state}`,
      );
    }
    const attempt = interaction.bindingAttempt;
    if (attempt === null || !attempt.valid) {
      this.#bindings.delete(sessionId);
      throw new SessionInteractionError(
        "interaction_not_connected",
        "The session is not connected to a tmux pane",
      );
    }
    const cached = this.#bindings.get(sessionId);
    if (
      cached !== undefined &&
      cached.attempt.ordinal === attempt.ordinal &&
      cached.attempt.socketPath === attempt.socketPath &&
      cached.attempt.paneId === attempt.paneId
    ) {
      return cached;
    }
    try {
      const binding = await this.tmux.connect(attempt);
      const next = { attempt, binding };
      this.#bindings.set(sessionId, next);
      return next;
    } catch (error) {
      return this.#translateConnectionError(sessionId, error);
    }
  }

  async #perform(sessionId: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (error instanceof TmuxInteractionError) {
        if (error.code === "disconnected") {
          this.#bindings.delete(sessionId);
          throw new SessionInteractionError(
            "interaction_not_connected",
            "The tmux target is no longer connected",
          );
        }
        if (error.code === "timeout") {
          throw new SessionInteractionError(
            "operation_result_unknown",
            "The tmux operation timed out; its result is unknown and was not retried",
          );
        }
        if (error.code === "command_failed") {
          throw new SessionInteractionError(
            "interaction_failed",
            "tmux could not complete the interaction operation",
          );
        }
      }
      throw error;
    }
  }

  #translateConnectionError(sessionId: string, error: unknown): never {
    this.#bindings.delete(sessionId);
    if (error instanceof TmuxInteractionError && error.code === "timeout") {
      throw new SessionInteractionError(
        "operation_result_unknown",
        "The tmux validation timed out; its result is unknown and was not retried",
      );
    }
    throw new SessionInteractionError(
      "interaction_not_connected",
      "The session is not connected to a valid tmux pane",
    );
  }

  #supported(session: InteractionSessionSnapshot): boolean {
    return this.enabled && !session.archived && session.interaction !== null;
  }
}

function response(
  activation: string,
  state: "unbound" | "disconnected" | "idle" | "running" | "awaiting_user_input",
): InteractionResponse {
  const connected = state !== "unbound" && state !== "disconnected";
  return {
    supported: true,
    state,
    activation,
    canSendMessage: state === "idle",
    canInterrupt: state === "running" || state === "awaiting_user_input",
    canSendEscape: connected,
  };
}
