import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_DIRECTIVE_CHARS,
  MAX_MESSAGE_CHARS,
} from "../../src/server/adapters/codex/limits.js";
import { normalizeRecords } from "./session-normalizer.fixtures.js";

describe("message and directive normalization", () => {
  it("keeps response messages as directives and emits event messages without matching", () => {
    const normalized = normalizeRecords("message-source-session", [
      {
        ordinal: 1,
        value: {
          type: "response_item",
          payload: {
            type: "message", role: "user",
            content: [{ type: "input_text", text: "Actual user" }],
          },
        },
      },
      {
        ordinal: 2,
        value: {
          type: "event_msg",
          payload: { type: "user_message", message: "Actual user" },
        },
      },
      {
        ordinal: 3,
        value: {
          type: "response_item",
          payload: {
            type: "message", role: "assistant", phase: "commentary",
            content: [{ type: "output_text", text: "Canonical assistant" }],
          },
        },
      },
      {
        ordinal: 4,
        value: {
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "Canonical assistant",
          },
        },
      },
    ]);

    expect(normalized.timeline.map((item) => [item.ordinal, item.kind])).toEqual([
      [1, "directive"],
      [2, "message"],
      [3, "directive"],
      [4, "message"],
    ]);
    expect(normalized.timeline[0]).toEqual(expect.objectContaining({
      hasDetail: false,
      text: "Actual user",
      charCount: 11,
    }));
    expect(normalized.directiveDetails.has("directive-1")).toBe(false);
    expect(normalized.session).toEqual(expect.objectContaining({
      title: "Actual user",
      preview: "Actual user",
      messageCount: 2,
    }));
    expect(normalized.timeline.filter((item) => item.kind === "message"))
      .toEqual([
        expect.objectContaining({ role: "user", markdown: "Actual user" }),
        expect.objectContaining({
          role: "assistant",
          phase: "commentary",
          markdown: "Canonical assistant",
        }),
      ]);
  });

  it("accepts only allowlisted message content parts and does not guess string content", () => {
    const normalized = normalizeRecords("strict-message-content-session", [
        {
          ordinal: 1,
          value: {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: "STRING_CONTENT_MUST_NOT_RENDER",
            },
          },
        },
        {
          ordinal: 2,
          value: {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [
                { type: "image_url", text: "NON_TEXT_PART_MUST_NOT_RENDER" },
                { type: "output_text", text: "Allowed assistant text" },
              ],
            },
          },
        },
    ]);
  
    expect(normalized.timeline).toEqual([
      expect.objectContaining({
        kind: "directive",
        ordinal: 2,
        hasDetail: false,
        text: "Allowed assistant text",
      }),
    ]);
    expect(normalized.directiveDetails.has("directive-2")).toBe(false);
    expect(JSON.stringify(normalized)).not.toContain("STRING_CONTENT_MUST_NOT_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("NON_TEXT_PART_MUST_NOT_RENDER");
  });

  it("inlines 500 characters and retains 501 characters as lazy detail", () => {
    const inlineText = "i".repeat(MAX_INLINE_DIRECTIVE_CHARS);
    const lazyText = "l".repeat(MAX_INLINE_DIRECTIVE_CHARS + 1);
    const normalized = normalizeRecords("directive-boundaries", [
      responseMessage(1, inlineText),
      responseMessage(2, lazyText),
    ]);

    expect(normalized.timeline[0]).toEqual(expect.objectContaining({
      kind: "directive",
      hasDetail: false,
      text: inlineText,
      charCount: MAX_INLINE_DIRECTIVE_CHARS,
    }));
    expect(normalized.directiveDetails.has("directive-1")).toBe(false);
    expect(normalized.timeline[1]).toEqual(expect.objectContaining({
      kind: "directive",
      hasDetail: true,
      summary: "l".repeat(240),
      charCount: MAX_INLINE_DIRECTIVE_CHARS + 1,
      truncated: false,
    }));
    expect(normalized.timeline[1]).not.toHaveProperty("text");
    expect(normalized.directiveDetails.get("directive-2")).toEqual({
      text: lazyText,
      truncated: false,
    });
  });

  it("emits completed items as typed assistant final Markdown messages", () => {
    const normalized = normalizeRecords("completed-item-session", [{
      ordinal: 1,
      value: {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "Plan", text: "# Plan\n\n- First step" },
        },
      },
    }]);

    expect(normalized.timeline).toEqual([expect.objectContaining({
      kind: "message",
      role: "assistant",
      phase: "final",
      itemType: "Plan",
      markdown: "# Plan\n\n- First step",
    })]);
  });

  it("limits completed item types to the message character boundary", () => {
    const itemType = "t".repeat(MAX_MESSAGE_CHARS + 1);
    const normalized = normalizeRecords("completed-item-type-boundary", [{
      ordinal: 1,
      value: {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: itemType, text: "Done" },
        },
      },
    }]);

    expect(normalized.timeline[0]).toEqual(expect.objectContaining({
      kind: "message",
      itemType: "t".repeat(MAX_MESSAGE_CHARS),
    }));
  });
});

function responseMessage(ordinal: number, text: string) {
  return {
    ordinal,
    value: {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    },
  };
}
