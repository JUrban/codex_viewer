import { describe, expect, it } from "vitest";
import { IdentityResolver } from "../../src/server/adapters/codex/identity-resolver.js";
import { DefaultSessionNormalizer } from "../../src/server/adapters/codex/session-normalizer.js";
import type { DecodedRecord } from "../../src/server/adapters/codex/rollout-decoder.js";
import { sessionMetadata } from "./session-normalizer.fixtures.js";

const descriptor = {
  id: "incremental",
  canonicalPath: "/synthetic/rollout-matching-thread.jsonl",
  sourceRelativePath: "sessions/rollout-matching-thread.jsonl",
  archived: false,
  size: 1,
  mtimeMs: 1,
};

describe("incremental Codex derivation", () => {
  it("updates identity copy-on-write when the first filename match arrives later", () => {
    const resolver = new IdentityResolver();
    const empty = resolver.create(descriptor);
    const before = resolver.append(empty, [record(1, {
      timestamp: "2026-08-08T00:00:01.000Z",
      type: "session_meta",
      payload: { id: "fallback", cwd: "/fallback" },
    })]);
    const after = resolver.append(before, [record(2, {
      timestamp: "2026-08-08T00:00:02.000Z",
      type: "session_meta",
      payload: {
        id: "matching-thread",
        cwd: "/matching",
        timestamp: "2026-08-07T23:59:00.000Z",
      },
    })]);

    expect(resolver.metadata(before)).toMatchObject({
      threadId: "fallback",
      cwd: "/fallback",
      createdAt: "2026-08-08T00:00:01.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z",
    });
    expect(resolver.metadata(after)).toMatchObject({
      threadId: "matching-thread",
      cwd: "/matching",
      createdAt: "2026-08-07T23:59:00.000Z",
      updatedAt: "2026-08-08T00:00:02.000Z",
    });
    expect(resolver.append(after, [])).toBe(after);
  });

  it("pairs tools and user input across batches without mutating the old snapshot", () => {
    const normalizer = new DefaultSessionNormalizer();
    const firstState = normalizer.append(normalizer.create(descriptor), [
      toolCall(1, "tool", "inspect", "input"),
      userInputRequest(2, "question"),
      eventMessage(3, "user_message", "First user title"),
      binding(4, "/tmp/valid.sock,1,0", "%1"),
    ], []);
    const before = normalizer.materialize(firstState, sessionMetadata());
    const oldCall = before.timeline[0];
    const oldCallDetail = before.toolDetails.get("tool-1");

    const secondState = normalizer.append(firstState, [
      toolOutput(5, "tool", "result"),
      toolOutput(6, "question", JSON.stringify({
        answers: { choice: { answers: ["Second"] } },
      })),
      binding(7, "malformed", "pane"),
    ], []);
    const after = normalizer.materialize(secondState, sessionMetadata());

    expect(after.timeline[0]).toBe(oldCall);
    expect(after.toolDetails.get("tool-1")).toBe(oldCallDetail);
    expect(after.timeline[4]).toMatchObject({
      kind: "tool", stage: "output", toolName: "inspect", preview: "result",
    });
    expect(after.timeline[5]).toMatchObject({
      kind: "user_input", stage: "response", outcome: "answered",
    });
    expect(after.interaction?.bindingAttempt).toEqual({ ordinal: 7, valid: false });
    expect(after.session).toMatchObject({
      title: "First user title", messageCount: 1, toolCount: 1, itemCount: 7,
    });
    expect(before.timeline).toHaveLength(4);
    expect(before.toolDetails).toHaveLength(1);
    expect(before.interaction?.bindingAttempt).toMatchObject({ ordinal: 4, valid: true });
  });

  it("recombines cumulative decoder diagnostics ahead of retained normalizer diagnostics", () => {
    const normalizer = new DefaultSessionNormalizer();
    const first = normalizer.append(
      normalizer.create(descriptor),
      [record(1, {})],
      [],
    );
    const before = normalizer.materialize(first, sessionMetadata());
    const decoderDiagnostics = Array.from({ length: 50 }, (_, index) => ({
      code: `decoder_${index}`,
      severity: "warning" as const,
      message: `Decoder warning ${index}`,
      ordinal: index + 1,
    }));
    const second = normalizer.append(first, [], decoderDiagnostics);
    const after = normalizer.materialize(second, sessionMetadata());

    expect(before.session.diagnostics.map(({ code }) => code)).toEqual(["unknown_record"]);
    expect(after.session.diagnostics).toEqual(decoderDiagnostics);
    expect(after.session.warningCount).toBe(50);
    expect(first.normalizerDiagnostics.map(({ code }) => code)).toEqual(["unknown_record"]);
    expect(normalizer.append(second, [], decoderDiagnostics)).toBe(second);
  });
});

function record(ordinal: number, value: Record<string, unknown>): DecodedRecord {
  return { ordinal, value };
}

function toolCall(ordinal: number, callId: string, name: string, input: string): DecodedRecord {
  return record(ordinal, {
    type: "response_item",
    payload: { type: "function_call", call_id: callId, name, arguments: input },
  });
}

function toolOutput(ordinal: number, callId: string, output: string): DecodedRecord {
  return record(ordinal, {
    type: "response_item",
    payload: { type: "function_call_output", call_id: callId, output },
  });
}

function userInputRequest(ordinal: number, callId: string): DecodedRecord {
  return record(ordinal, {
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input",
      call_id: callId,
      arguments: JSON.stringify({
        questions: [{
          header: "Choice",
          id: "choice",
          question: "Which option?",
          options: [
            { label: "First", description: "First option." },
            { label: "Second", description: "Second option." },
          ],
        }],
      }),
    },
  });
}

function eventMessage(
  ordinal: number,
  type: "user_message" | "agent_message",
  message: string,
): DecodedRecord {
  return record(ordinal, { type: "event_msg", payload: { type, message } });
}

function binding(ordinal: number, tmux: string, pane: string): DecodedRecord {
  const command = "printf 'CODEX_VIEWER_TMUX_BIND_V1\\n%s\\n%s\\n' \"$TMUX\" \"$TMUX_PANE\"";
  return record(ordinal, {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `<user_shell_command>\n${command}\nCODEX_VIEWER_TMUX_BIND_V1\n${tmux}\n${pane}\n</user_shell_command>`,
      }],
    },
  });
}
