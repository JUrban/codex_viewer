import { describe, expect, it } from "vitest";
import { IdentityResolver } from "../../src/server/codex/identity-resolver.js";
import { MAX_SESSION_TITLE_CHARS } from "../../src/server/codex/limits.js";
import { DefaultSessionNormalizer } from "../../src/server/codex/session-normalizer.js";
import {
  decodedRollout,
  normalizeFixture,
  normalizeRecords,
} from "./session-normalizer.fixtures.js";

describe("session identity and recovery", () => {
  it("uses response messages as canonical and classifies synthetic user and developer messages as directives", async () => {
    const normalized = await normalizeFixture("rollout-2026-07-28T10-00-00-basic-session.jsonl");
    const messages = normalized.timeline.filter((item) => item.kind === "message");
    expect(messages).toHaveLength(3);
    expect(messages.filter((item) => item.role === "user")).toHaveLength(1);
    expect(messages.filter((item) => item.role === "assistant")).toHaveLength(2);
    expect(messages.find((item) => item.markdown === "Final synthetic answer.")?.phase).toBe("final");
    const directives = normalized.timeline.filter((item) => item.kind === "directive");
    expect(directives).toHaveLength(2);
    expect(directives[0]).toEqual(expect.objectContaining({
      id: "directive-4",
      summary: "Directive configuration summary",
      charCount: 55,
      hasDetail: true,
    }));
    expect(normalized.directiveDetails.get("directive-4")).toEqual({
      text: "Directive configuration summary\nDIRECTIVE_DETAIL_CANARY",
      truncated: false,
    });
    expect(directives[1]).toEqual(expect.objectContaining({
      id: "directive-5",
      summary: "DEVELOPER_DIRECTIVE_CANARY",
      charCount: 26,
      hasDetail: true,
    }));
    expect(normalized.directiveDetails.get("directive-5")).toEqual({
      text: "DEVELOPER_DIRECTIVE_CANARY",
      truncated: false,
    });
    expect(normalized.session.messageCount).toBe(3);
    expect(normalized.session.sourceId).toBe("basic-session");
    expect(
      normalized.timeline.filter((item) =>
        item.kind === "internal" && item.eventType === "reasoning"
      ),
    ).toEqual([
      expect.objectContaining({
        id: "internal-6",
        eventType: "reasoning",
        summary: "REASONING_SUMMARY_CANARY",
      }),
      expect.objectContaining({
        id: "internal-18",
        eventType: "reasoning",
        summary: "Internal event: reasoning",
      }),
    ]);
    expect(JSON.stringify(normalized)).not.toContain("REASONING_CANARY_NEVER_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("EMPTY_REASONING_CANARY_NEVER_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("INTERNAL_PAYLOAD_CANARY");
    expect(normalized.session.title).toBe("Synthetic trace");
  });

  it("bounds JSONL titles to the first non-empty line", () => {
    const longLine = "A JSONL title that should stay compact ".repeat(8);
    const normalized = normalizeRecords("long-title-session", [], {
      threadId: "long-title-session",
      title: ` \n\n ${longLine}\nIgnored title continuation`,
    });
  
    expect(normalized.session.title).toBe(longLine.trim().slice(0, MAX_SESSION_TITLE_CHARS));
    expect(normalized.session.title).toHaveLength(MAX_SESSION_TITLE_CHARS);
    expect(normalized.session.title).not.toContain("\n");
  });

  it("falls back to the first user message and record timestamps", () => {
    const decoded = decodedRollout("fallback-session", [
      {
        ordinal: 1,
        value: {
          timestamp: "2026-07-28T12:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fallback title from user" }],
          },
        },
      },
      {
        ordinal: 2,
        value: {
          timestamp: "2026-07-28T12:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Fallback title from user",
          },
        },
      },
      {
        ordinal: 3,
        value: {
          timestamp: "2026-07-28T12:00:05.000Z",
          type: "event_msg",
          payload: { type: "token_count" },
        },
      },
    ]);
    const normalized = new DefaultSessionNormalizer().normalize(
      decoded,
      new IdentityResolver().resolve(decoded),
    );

    expect(normalized.session).toEqual(expect.objectContaining({
      title: "Fallback title from user",
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:05.000Z",
    }));
  });

  it("chooses filename-matching metadata when duplicate metadata records exist", async () => {
    const normalized = await normalizeFixture("rollout-2026-07-28T11-00-00-child-session.jsonl");
    expect(normalized.session.cwd).toBe("/synthetic/child");
    expect(normalized.session.parentId).toBe("basic-session");
    expect(normalized.session.agent).toEqual({
      taskName: "widget_review",
      nickname: "Sagan",
      role: "reviewer",
    });
  });

  it("keeps valid records after a malformed middle line and marks the source partial", async () => {
    const normalized = await normalizeFixture("rollout-2026-07-28T12-00-00-malformed-session.jsonl");
    expect(normalized.timeline.filter((item) => item.kind === "message")).toHaveLength(1);
    expect(normalized.timeline.filter((item) => item.kind === "directive")).toHaveLength(1);
    expect(normalized.session.sourceState).toBe("partial");
    expect(normalized.session.diagnostics).toEqual([
      expect.objectContaining({ code: "malformed_json", ordinal: 3 }),
    ]);
  });
});
