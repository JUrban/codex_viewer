import { describe, expect, it } from "vitest";
import { normalizeRecords } from "./session-normalizer.fixtures.js";

describe("message and directive normalization", () => {
  it("classifies unmatched message events as directives with retrievable detail", () => {
    const normalized = normalizeRecords("message-source-session", [
        {
          ordinal: 1,
          value: {
            type: "response_item",
            payload: {
              type: "message", role: "user",
              content: [{ type: "input_text", text: "Directive summary\nDIRECTIVE_ONLY_SECRET" }],
            },
          },
        },
        {
          ordinal: 2,
          value: {
            type: "response_item",
            payload: {
              type: "message", role: "user",
              content: [
                { type: "input_text", text: "Actual user" },
                { type: "input_text", text: "input" },
              ],
            },
          },
        },
        {
          ordinal: 3,
          value: {
            type: "event_msg",
            payload: { type: "user_message", message: "Actual user\n\ninput" },
          },
        },
        {
          ordinal: 4,
          value: {
            type: "response_item",
            payload: {
              type: "message", role: "assistant", phase: "commentary",
              content: [
                { type: "output_text", text: "Canonical" },
                { type: "text", text: "assistant" },
              ],
            },
          },
        },
        {
          ordinal: 5,
          value: {
            type: "event_msg",
            payload: {
              type: "agent_message",
              phase: "commentary",
              message: "Canonical\n\nassistant",
            },
          },
        },
        {
          ordinal: 6,
          value: {
            type: "event_msg",
            payload: { type: "agent_message", phase: "commentary", message: "Propagated parent text" },
          },
        },
        {
          ordinal: 7,
          value: {
            type: "event_msg",
            payload: { type: "user_message", message: "Unmatched user event" },
          },
        },
    ]);
  
    expect(normalized.timeline.map((item) => [item.ordinal, item.kind])).toEqual([
      [1, "directive"],
      [2, "message"],
      [4, "message"],
      [6, "directive"],
      [7, "directive"],
    ]);
    expect(normalized.timeline[3]).toEqual(expect.objectContaining({
      id: "directive-6",
      summary: "Propagated parent text",
      charCount: 22,
      hasDetail: true,
    }));
    expect(normalized.directiveDetails.get("directive-6")).toEqual({
      text: "Propagated parent text",
      truncated: false,
    });
    expect(normalized.timeline[4]).toEqual(expect.objectContaining({
      id: "directive-7",
      summary: "Unmatched user event",
      charCount: 20,
      hasDetail: true,
    }));
    expect(normalized.directiveDetails.get("directive-7")).toEqual({
      text: "Unmatched user event",
      truncated: false,
    });
    expect(normalized.session).toEqual(expect.objectContaining({
      title: "Actual user",
      preview: "Actual user\n\ninput",
      messageCount: 2,
    }));
    expect(normalized.timeline.filter((item) => item.kind === "message").map((item) => item.markdown))
      .toEqual(["Actual user\n\ninput", "Canonical\n\nassistant"]);
    expect(JSON.stringify(normalized.timeline)).not.toContain("DIRECTIVE_ONLY_SECRET");
    expect(JSON.stringify(normalized.timeline)).toContain("Propagated parent text");
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
        kind: "message",
        ordinal: 2,
        markdown: "Allowed assistant text",
      }),
    ]);
    expect(JSON.stringify(normalized)).not.toContain("STRING_CONTENT_MUST_NOT_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("NON_TEXT_PART_MUST_NOT_RENDER");
  });
});
