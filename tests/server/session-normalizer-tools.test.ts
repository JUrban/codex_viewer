import { describe, expect, it } from "vitest";
import {
  MAX_DIRECTIVE_CHARS,
  MAX_TOOL_DETAIL_CHARS,
} from "../../src/server/adapters/codex/limits.js";
import { MAX_PREVIEW_CHARS } from "../../src/server/domain/session-text.js";
import {
  normalizeFixture,
  normalizeRecords,
} from "./session-normalizer.fixtures.js";

describe("tool normalization", () => {
  it("emits append-stable call and output items with public call IDs", async () => {
    const normalized = await normalizeFixture("rollout-2026-07-28T10-00-00-basic-session.jsonl");
    const tools = normalized.timeline.filter((item) => item.kind === "tool");
    expect(tools.map((item) => [
      item.stage,
      item.callId,
      item.toolName,
      item.stage === "output" ? item.status : null,
    ])).toEqual([
      ["call", "call-complete", "inspect_widget", null],
      ["output", "call-complete", "inspect_widget", "completed"],
      ["call", "call-pending", "pending_widget", null],
      ["call", "custom-string", "custom_string", null],
      ["output", "custom-string", "custom_string", "completed"],
      ["call", "custom-array", "custom_array", null],
      ["output", "custom-array", "custom_array", "completed"],
    ]);
    expect(normalized.toolDetails.get("tool-7")).toMatchObject({
      input: '{"id":"sample"}',
      output: null,
    });
    expect(normalized.toolDetails.get("tool-8")?.output).toBe("synthetic result");
    expect(normalized.toolDetails.get("tool-13")?.output).toBe("string-shaped output");
    expect(normalized.toolDetails.get("tool-15")?.output).toBe("array shaped output");
    expect(normalized.session.toolCount).toBe(4);
  });

  it("truncates oversized synthetic tool input and output before retaining detail", async () => {
    const oversized = "x".repeat(MAX_TOOL_DETAIL_CHARS + 32);
    const normalized = normalizeRecords("oversized-tool-session", [
        {
          ordinal: 1,
          value: {
            type: "response_item",
            payload: { type: "function_call", name: "bounded", call_id: "big", arguments: oversized },
          },
        },
        {
          ordinal: 2,
          value: {
            type: "response_item",
            payload: { type: "function_call_output", call_id: "big", output: oversized },
          },
        },
        {
          ordinal: 3,
          value: {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: oversized }],
            },
          },
        },
        {
          ordinal: 4,
          value: {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: oversized }],
            },
          },
        },
    ]);
    const callDetail = normalized.toolDetails.get("tool-1");
    const outputDetail = normalized.toolDetails.get("tool-2");
    const call = normalized.timeline.find((item) => item.id === "tool-1");
    const output = normalized.timeline.find((item) => item.id === "tool-2");
    const directiveItem = normalized.timeline.find((item) => item.id === "directive-3");
    expect(call?.kind === "tool" ? call.preview : null).toHaveLength(MAX_PREVIEW_CHARS);
    expect(output?.kind === "tool" ? output.preview : null).toHaveLength(MAX_PREVIEW_CHARS);
    expect(callDetail?.input).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(callDetail?.output).toBeNull();
    expect(outputDetail?.input).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(outputDetail?.output).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(callDetail?.truncated).toBe(true);
    expect(outputDetail?.truncated).toBe(true);
    const directive = normalized.directiveDetails.get("directive-3");
    expect(normalized.session.preview).toHaveLength(MAX_PREVIEW_CHARS);
    expect(directiveItem?.kind === "directive" ? directiveItem.summary : null)
      .toHaveLength(MAX_PREVIEW_CHARS);
    expect(directive?.text).toHaveLength(MAX_DIRECTIVE_CHARS);
    expect(directive?.truncated).toBe(true);
  });

  it("uses the nearest preceding duplicate call and never backfills orphan outputs", () => {
    const normalized = normalizeRecords("tool-order", [
      toolOutput(1, "shared", "orphan"),
      toolCall(2, "shared", "first", "first input"),
      toolOutput(3, "shared", "first output"),
      toolCall(4, "shared", "second", "second input"),
      toolOutput(5, "shared", null, true),
      toolOutput(6, "shared", "repeated output"),
    ]);
    const tools = normalized.timeline.filter((item) => item.kind === "tool");

    expect(tools.map((item) => [
      item.ordinal,
      item.stage,
      item.toolName,
      item.preview,
      item.stage === "output" ? item.status : null,
    ])).toEqual([
      [1, "output", "unknown tool", "orphan", "completed"],
      [2, "call", "first", "first input", null],
      [3, "output", "first", "first output", "completed"],
      [4, "call", "second", "second input", null],
      [5, "output", "second", "second input", "failed"],
      [6, "output", "second", "repeated output", "completed"],
    ]);
    expect(normalized.toolDetails.get("tool-1")).toMatchObject({
      input: null,
      output: "orphan",
    });
    expect(normalized.toolDetails.get("tool-3")?.input).toBe("first input");
    expect(normalized.toolDetails.get("tool-5")).toMatchObject({
      input: "second input",
      output: null,
    });
    expect(normalized.session.toolCount).toBe(2);
    expect(normalized.session.itemCount).toBe(6);
  });

  it("does not rewrite an existing call when its output arrives", () => {
    const call = toolCall(1, "append", "inspect", "input");
    const before = normalizeRecords("before-output", [call]);
    const after = normalizeRecords("after-output", [
      call,
      toolOutput(2, "append", "result"),
    ]);

    expect(after.timeline[0]).toEqual(before.timeline[0]);
    expect(after.toolDetails.get("tool-1"))
      .toEqual(before.toolDetails.get("tool-1"));
    expect(before.timeline[0]).not.toHaveProperty("status");
    expect(after.timeline[1]).toMatchObject({
      kind: "tool",
      stage: "output",
      callId: "append",
      status: "completed",
    });
  });

  it("does not report detail truncation when only the preview is truncated", () => {
    const input = "x".repeat(MAX_PREVIEW_CHARS + 1);
    const normalized = normalizeRecords("preview-only-truncation", [
      toolCall(1, "preview", "inspect", input),
    ]);
    const item = normalized.timeline[0];
    const detail = normalized.toolDetails.get("tool-1");

    expect(item).toMatchObject({
      kind: "tool",
      stage: "call",
      preview: "x".repeat(MAX_PREVIEW_CHARS),
      truncated: true,
    });
    expect(detail).toEqual({
      input,
      output: null,
      truncated: false,
    });
  });
});

function toolCall(ordinal: number, callId: string, name: string, input: string) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: { type: "function_call", call_id: callId, name, arguments: input },
    },
  };
}

function toolOutput(
  ordinal: number,
  callId: string,
  output: string | null,
  failed = false,
) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: callId,
        output,
        status: failed ? "failed" : undefined,
      },
    },
  };
}
