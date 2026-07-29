import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IdentityResolver } from "../../src/server/codex/identity-resolver.js";
import {
  MAX_DIRECTIVE_CHARS,
  MAX_PREVIEW_CHARS,
  MAX_SESSION_TITLE_CHARS,
  MAX_TOOL_DETAIL_CHARS,
} from "../../src/server/codex/limits.js";
import { WholeFileRolloutDecoder, type DecodedRollout } from "../../src/server/codex/rollout-decoder.js";
import { DefaultSessionNormalizer } from "../../src/server/codex/session-normalizer.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";

const fixtureHome = resolve("tests/fixtures/codex-home");

async function normalize(fileName: string) {
  const policy = await PathPolicy.create(fixtureHome);
  const descriptor = await policy.register(resolve(fixtureHome, "sessions/2026/07/28", fileName));
  const decoded = await new WholeFileRolloutDecoder().decode(descriptor!);
  const metadata = new IdentityResolver().resolve(decoded, null);
  return new DefaultSessionNormalizer().normalize(decoded, metadata);
}

describe("IdentityResolver and SessionNormalizer", () => {
  it("uses response messages as canonical and classifies synthetic user and developer messages as directives", async () => {
    const normalized = await normalize("rollout-2026-07-28T10-00-00-basic-session.jsonl");
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

  it("bounds catalog titles to the first non-empty line", () => {
    const longLine = "A catalog title that should stay compact ".repeat(8);
    const normalized = new DefaultSessionNormalizer().normalize({
      descriptor: {
        id: "long-title-session",
        canonicalPath: "/synthetic/rollout-long-title.jsonl",
        archived: false,
        size: 1,
        mtimeMs: 1,
        device: 1,
        inode: 1,
      },
      diagnostics: [],
      incompleteTail: false,
      records: [],
    }, {
      threadId: "long-title-session",
      title: ` \n\n ${longLine}\nIgnored title continuation`,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      parentThreadId: null,
      archived: false,
    });

    expect(normalized.session.title).toBe(longLine.trim().slice(0, MAX_SESSION_TITLE_CHARS));
    expect(normalized.session.title).toHaveLength(MAX_SESSION_TITLE_CHARS);
    expect(normalized.session.title).not.toContain("\n");
  });

  it("classifies unmatched message events as directives with retrievable detail", () => {
    const descriptor = {
      id: "message-source-session",
      canonicalPath: "/synthetic/rollout-message-source.jsonl",
      archived: false,
      size: 1,
      mtimeMs: 1,
      device: 1,
      inode: 1,
    };
    const normalized = new DefaultSessionNormalizer().normalize({
      descriptor,
      diagnostics: [],
      incompleteTail: false,
      records: [
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
      ],
    }, {
      threadId: null,
      title: null,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      parentThreadId: null,
      archived: false,
    });

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

  it("shows turn context safely and retains allowlisted total and last token usage", () => {
    const descriptor = {
      id: "internal-detail-session",
      canonicalPath: "/synthetic/rollout-internal-detail.jsonl",
      archived: false,
      size: 1,
      mtimeMs: 1,
      device: 1,
      inode: 1,
    };
    const normalized = new DefaultSessionNormalizer().normalize({
      descriptor,
      diagnostics: [],
      incompleteTail: false,
      records: [
        {
          ordinal: 1,
          value: {
            timestamp: "2026-07-28T20:00:00Z",
            type: "turn_context",
            payload: {
              cwd: "/TURN_CONTEXT_MUST_NOT_RENDER",
              model: "MODEL_MUST_NOT_RENDER",
            },
          },
        },
        {
          ordinal: 2,
          value: {
            timestamp: "2026-07-28T20:00:01Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  total_tokens: 12_345,
                  input_tokens: 10_000,
                  cached_input_tokens: 4_000,
                  cache_write_input_tokens: 500,
                  output_tokens: 2_000,
                  reasoning_output_tokens: 345,
                  UNKNOWN_TOKEN_FIELD_MUST_NOT_RENDER: 99,
                },
                last_token_usage: {
                  total_tokens: 678,
                  input_tokens: 500,
                  cached_input_tokens: 100,
                  cache_write_input_tokens: -1,
                  output_tokens: 150,
                  reasoning_output_tokens: "28",
                },
              },
              rate_limits: { secret: "RATE_LIMIT_MUST_NOT_RENDER" },
            },
          },
        },
        {
          ordinal: 3,
          value: {
            type: "event_msg",
            payload: { type: "token_count", rate_limits: { used_percent: 25 } },
          },
        },
      ],
    }, {
      threadId: null,
      title: null,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      parentThreadId: null,
      archived: false,
    });

    expect(normalized.timeline).toEqual([
      {
        kind: "internal",
        id: "internal-1",
        ordinal: 1,
        timestamp: "2026-07-28T20:00:00Z",
        eventType: "turn_context",
        summary: "Internal event: turn_context",
      },
      {
        kind: "token",
        id: "token-2",
        ordinal: 2,
        timestamp: "2026-07-28T20:00:01Z",
        tokenUsage: {
          total: {
            totalTokens: 12_345,
            inputTokens: 10_000,
            cachedInputTokens: 4_000,
            cacheWriteInputTokens: 500,
            outputTokens: 2_000,
            reasoningOutputTokens: 345,
          },
          last: {
            totalTokens: 678,
            inputTokens: 500,
            cachedInputTokens: 100,
            cacheWriteInputTokens: null,
            outputTokens: 150,
            reasoningOutputTokens: null,
          },
        },
      },
      {
        kind: "token",
        id: "token-3",
        ordinal: 3,
        timestamp: null,
        tokenUsage: {
          total: null,
          last: null,
        },
      },
    ]);
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("TURN_CONTEXT_MUST_NOT_RENDER");
    expect(serialized).not.toContain("MODEL_MUST_NOT_RENDER");
    expect(serialized).not.toContain("UNKNOWN_TOKEN_FIELD_MUST_NOT_RENDER");
    expect(serialized).not.toContain("RATE_LIMIT_MUST_NOT_RENDER");
  });

  it("accepts only allowlisted message content parts and does not guess string content", () => {
    const descriptor = {
      id: "strict-message-content-session",
      canonicalPath: "/synthetic/rollout-strict-message-content.jsonl",
      archived: false,
      size: 1,
      mtimeMs: 1,
      device: 1,
      inode: 1,
    };
    const normalized = new DefaultSessionNormalizer().normalize({
      descriptor,
      diagnostics: [],
      incompleteTail: false,
      records: [
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
      ],
    }, {
      threadId: null,
      title: null,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      parentThreadId: null,
      archived: false,
    });

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

  it("pairs completed tools, leaves unmatched calls pending, and bounds detail", async () => {
    const normalized = await normalize("rollout-2026-07-28T10-00-00-basic-session.jsonl");
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
    const policy = await PathPolicy.create(fixtureHome);
    const descriptor = await policy.register(resolve(fixtureHome, "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl"));
    const oversized = "x".repeat(MAX_TOOL_DETAIL_CHARS + 32);
    const decoded: DecodedRollout = {
      descriptor: descriptor!,
      diagnostics: [],
      incompleteTail: false,
      records: [
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
      ],
    };
    const normalized = new DefaultSessionNormalizer().normalize(decoded, {
      threadId: null,
      title: null,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      parentThreadId: null,
      archived: false,
    });
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

  it("chooses filename-matching metadata when duplicate metadata records exist", async () => {
    const normalized = await normalize("rollout-2026-07-28T11-00-00-child-session.jsonl");
    expect(normalized.session.cwd).toBe("/synthetic/child");
    expect(normalized.session.parentId).toBe("basic-session");
    expect(normalized.session.agent).toEqual({
      taskName: "widget_review",
      nickname: "Sagan",
      role: "reviewer",
    });
  });

  it("keeps valid records after a malformed middle line and marks the source partial", async () => {
    const normalized = await normalize("rollout-2026-07-28T12-00-00-malformed-session.jsonl");
    expect(normalized.timeline.filter((item) => item.kind === "message")).toHaveLength(1);
    expect(normalized.timeline.filter((item) => item.kind === "directive")).toHaveLength(1);
    expect(normalized.session.sourceState).toBe("partial");
    expect(normalized.session.diagnostics).toEqual([
      expect.objectContaining({ code: "malformed_json", ordinal: 3 }),
    ]);
  });
});
