import { describe, expect, it } from "vitest";
import { CODEX_TMUX_ACTIVATION } from "../../src/server/adapters/codex/interaction-parser.js";
import { normalizeRecords } from "./session-normalizer.fixtures.js";

const STORED_TMUX_ACTIVATION =
  "printf 'CODEX_VIEWER_TMUX_BIND_V1\\n%s\\n%s\\n' \"$TMUX\" \"$TMUX_PANE\"";

function response(ordinal: number, payload: Record<string, unknown>) {
  return {
    ordinal,
    value: {
      type: "response_item",
      timestamp: `2026-08-01T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
      payload,
    },
  };
}

function shellText(tmux: string, pane: string) {
  return `<user_shell_command>\n${STORED_TMUX_ACTIVATION}\nChunk ID: bind\nProcess exited with code 0\nFinal output:\nCODEX_VIEWER_TMUX_BIND_V1\n${tmux}\n${pane}\n</user_shell_command>`;
}

describe("Codex interaction adapter", () => {
  it("exposes a shell trigger while matching Codex's stored command", () => {
    expect(CODEX_TMUX_ACTIVATION).toBe(`! ${STORED_TMUX_ACTIVATION}`);
  });

  it("recognizes a binding only in a user response_item shell command", () => {
    const normalized = normalizeRecords("binding", [
      response(1, {
        type: "custom_tool_call_output",
        call_id: "tool",
        output: "CODEX_VIEWER_TMUX_BIND_V1\n/tmp/wrong,1,0\n%1",
      }),
      {
        ordinal: 2,
        value: {
          type: "event_msg",
          payload: { type: "user_message", message: shellText("/tmp/also-wrong,2,0", "%2") },
        },
      },
      response(3, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/tmux.sock,123,0", "%7") }],
      }),
    ]);

    expect(normalized.interaction).toEqual({
      activation: CODEX_TMUX_ACTIVATION,
      bindingAttempt: {
        ordinal: 3,
        valid: true,
        socketPath: "/tmp/tmux.sock",
        paneId: "%7",
      },
      state: "running",
    });
  });

  it("uses only the latest activation attempt and does not fall back", () => {
    const normalized = normalizeRecords("latest-binding", [
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/valid.sock,10,0", "%1") }],
      }),
      response(8, {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: shellText("malformed", "pane-8"),
        }],
      }),
    ]);

    expect(normalized.interaction?.bindingAttempt).toEqual({ ordinal: 8, valid: false });
  });

  it("treats a damaged latest shell-command wrapper as a failed attempt", () => {
    const normalized = normalizeRecords("damaged-binding", [
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/valid.sock,10,0", "%1") }],
      }),
      response(9, {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "<user_shell_command>\nCODEX_VIEWER_TMUX_BIND_V1\n/tmp/new.sock,11,0\n%2",
        }],
      }),
    ]);
    expect(normalized.interaction?.bindingAttempt).toEqual({ ordinal: 9, valid: false });
  });

  it("records an activation command with no marker output as a failed attempt", () => {
    const normalized = normalizeRecords("failed-command", [
      response(1, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: shellText("/tmp/valid.sock,10,0", "%1") }],
      }),
      response(10, {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `<user_shell_command>\n${STORED_TMUX_ACTIVATION}\nProcess exited with code 1\nFinal output:\nerror\n</user_shell_command>`,
        }],
      }),
    ]);
    expect(normalized.interaction?.bindingAttempt).toEqual({ ordinal: 10, valid: false });
  });

  it("derives idle, running, and awaiting-user-input states", () => {
    const running = normalizeRecords("running", [{
      ordinal: 1,
      value: { type: "event_msg", payload: { type: "user_message", message: "go" } },
    }]);
    const idle = normalizeRecords("idle", [
      { ordinal: 1, value: { type: "event_msg", payload: { type: "user_message", message: "go" } } },
      response(2, {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "done" }],
      }),
    ]);
    const awaiting = normalizeRecords("awaiting", [
      response(1, {
        type: "function_call",
        name: "request_user_input",
        call_id: "question",
        arguments: "{\"questions\":[]}",
      }),
    ]);
    expect(running.interaction?.state).toBe("running");
    expect(idle.interaction?.state).toBe("idle");
    expect(awaiting.interaction?.state).toBe("awaiting_user_input");
  });

  it.each(["turn_aborted", "task_complete"])(
    "clears pending user input when %s ends the turn",
    (eventType) => {
      const normalized = normalizeRecords(`pending-${eventType}`, [
        response(1, {
          type: "function_call",
          name: "request_user_input",
          call_id: "question",
          arguments: "{\"questions\":[]}",
        }),
        {
          ordinal: 2,
          value: {
            type: "event_msg",
            payload: { type: eventType },
          },
        },
      ]);

      expect(normalized.interaction?.state).toBe("idle");
    },
  );
});
