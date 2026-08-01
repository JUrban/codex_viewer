import { describe, expect, it, vi } from "vitest";
import { SessionInteractionService } from "../../src/server/interaction/interaction-service.js";
import type {
  InteractionSessionSnapshot,
  SessionRepository,
} from "../../src/server/repository/session-repository.js";
import { CODEX_TMUX_ACTIVATION } from "../../src/server/adapters/codex/interaction-parser.js";

function repository(snapshot: InteractionSessionSnapshot | null): SessionRepository {
  return {
    list: vi.fn(),
    getSession: vi.fn(),
    getItems: vi.fn(),
    getToolDetail: vi.fn(),
    getDirectiveDetail: vi.fn(),
    getInteractionSession: vi.fn().mockResolvedValue(snapshot),
    refresh: vi.fn(),
  };
}

function session(
  state: "idle" | "running" | "awaiting_user_input",
  archived = false,
): InteractionSessionSnapshot {
  return {
    archived,
    interaction: {
      activation: CODEX_TMUX_ACTIVATION,
      bindingAttempt: null,
      state,
    },
  };
}

describe("session interaction policy", () => {
  it("is unsupported when disabled or archived", async () => {
    expect(await new SessionInteractionService(repository(session("idle")), false)
      .describe("session")).toEqual({ supported: false });
    expect(await new SessionInteractionService(repository(session("idle", true)), true)
      .describe("session")).toEqual({ supported: false });
  });

  it("reports unbound and enforces action state before transport", async () => {
    const idle = new SessionInteractionService(repository(session("idle")), true);
    expect(await idle.describe("session")).toEqual({
      supported: true,
      state: "unbound",
      activation: CODEX_TMUX_ACTIVATION,
      canSendMessage: false,
      canInterrupt: false,
      canSendEscape: false,
    });
    await expect(idle.interrupt("session")).rejects.toMatchObject({
      code: "interaction_state_conflict",
    });

    const running = new SessionInteractionService(repository(session("running")), true);
    await expect(running.sendMessage("session", "hello")).rejects.toMatchObject({
      code: "interaction_state_conflict",
    });
    await expect(running.interrupt("session")).rejects.toMatchObject({
      code: "interaction_not_connected",
    });
  });
});
