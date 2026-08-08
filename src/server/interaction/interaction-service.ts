import type {
  InteractionResponse,
  InteractionKey,
  TerminalPreviewResponse,
} from "../../shared/api-contract.js";
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

export class SessionInteractionError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "interaction_not_supported"
      | "interaction_not_connected"
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

interface ResolvedBinding extends CachedBinding {
  readonly keyBindings: NonNullable<InteractionSessionSnapshot["interaction"]>["keyBindings"];
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
    return this.describeSnapshot(sessionId, session);
  }

  async describeSnapshot(
    sessionId: string,
    session: InteractionSessionSnapshot,
  ): Promise<InteractionResponse> {
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
      return response(interaction.activation, "connected");
    } catch {
      this.#bindings.delete(sessionId);
      return response(interaction.activation, "disconnected");
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const { binding } = await this.#resolve(sessionId);
    await this.#perform(sessionId, () => this.tmux.sendMessage(binding, message));
  }

  async sendKeys(sessionId: string, keys: readonly InteractionKey[]): Promise<void> {
    const { binding, keyBindings } = await this.#resolve(sessionId);
    const mapped = keys.map((key) => keyBindings[key]);
    await this.#perform(sessionId, () => this.tmux.sendKeys(binding, mapped));
  }

  async preview(sessionId: string): Promise<TerminalPreviewResponse> {
    const { binding } = await this.#resolve(sessionId);
    const result = await this.#perform(
      sessionId,
      () => this.tmux.captureTerminal(binding),
    );
    return {
      ...result,
      capturedAt: new Date().toISOString(),
    };
  }

  async #resolve(sessionId: string): Promise<ResolvedBinding> {
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
      return { ...cached, keyBindings: interaction.keyBindings };
    }
    try {
      const binding = await this.tmux.connect(attempt);
      const next = { attempt, binding };
      this.#bindings.set(sessionId, next);
      return { ...next, keyBindings: interaction.keyBindings };
    } catch (error) {
      return this.#translateConnectionError(sessionId, error);
    }
  }

  async #perform<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
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
  state: "unbound" | "disconnected" | "connected",
): InteractionResponse {
  return {
    supported: true,
    state,
    activation,
  };
}
