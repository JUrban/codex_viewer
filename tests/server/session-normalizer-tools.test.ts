import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_DIRECTIVE_CHARS,
  MAX_TOOL_DETAIL_CHARS,
} from "../../src/server/adapters/codex/limits.js";
import { MAX_PREVIEW_CHARS } from "../../src/server/domain/session-text.js";
import {
  fixtureHome,
  normalizeFixture,
  normalizeRecords,
} from "./session-normalizer.fixtures.js";

describe("tool normalization", () => {
  it("pairs completed tools, leaves unmatched calls pending, and bounds detail", async () => {
    const normalized = await normalizeFixture("rollout-2026-07-28T10-00-00-basic-session.jsonl");
    const tools = normalized.timeline.filter((item) => item.kind === "tool");
    expect(tools.map((item) => [item.toolName, item.status])).toEqual([
      ["inspect_widget", "completed"],
      ["pending_widget", "pending"],
      ["custom_string", "completed"],
      ["custom_array", "completed"],
    ]);
    expect(normalized.toolDetails.get(tools[0]!.id)?.output).toBe("synthetic result");
    expect(normalized.toolDetails.get(tools[2]!.id)?.output).toBe("string-shaped output");
    expect(normalized.toolDetails.get(tools[3]!.id)?.output).toBe("array shaped output");
  
    const source = await readFile(resolve(fixtureHome, "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl"), "utf8");
    expect(source.length).toBeLessThan(MAX_TOOL_DETAIL_CHARS);
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
    const detail = normalized.toolDetails.get("tool-1");
    const tool = normalized.timeline.find((item) => item.id === "tool-1");
    const directiveItem = normalized.timeline.find((item) => item.id === "directive-3");
    expect(tool?.kind === "tool" ? tool.preview : null).toHaveLength(MAX_PREVIEW_CHARS);
    expect(detail?.input).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(detail?.output).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(detail?.truncated).toBe(true);
    const directive = normalized.directiveDetails.get("directive-3");
    expect(normalized.session.preview).toHaveLength(MAX_PREVIEW_CHARS);
    expect(directiveItem?.kind === "directive" ? directiveItem.summary : null)
      .toHaveLength(MAX_PREVIEW_CHARS);
    expect(directive?.text).toHaveLength(MAX_DIRECTIVE_CHARS);
    expect(directive?.truncated).toBe(true);
  });
});
