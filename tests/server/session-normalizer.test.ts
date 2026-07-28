import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IdentityResolver } from "../../src/server/codex/identity-resolver.js";
import { MAX_TOOL_DETAIL_CHARS } from "../../src/server/codex/limits.js";
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
  it("deduplicates adjacent mirrors, preserves true repeats, and strips sensitive raw content", async () => {
    const normalized = await normalize("rollout-2026-07-28T10-00-00-basic-session.jsonl");
    const messages = normalized.items.filter((item) => item.kind === "message");
    expect(messages).toHaveLength(4);
    expect(messages.filter((item) => item.role === "user")).toHaveLength(2);
    expect(messages.filter((item) => item.role === "assistant")).toHaveLength(2);
    expect(messages.find((item) => item.markdown === "Final synthetic answer.")?.phase).toBe("final");
    expect(normalized.items.filter((item) => item.kind === "reasoning-unavailable")).toHaveLength(1);
    expect(JSON.stringify(normalized)).not.toContain("REASONING_CANARY_NEVER_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("DEVELOPER_CANARY_NEVER_RENDER");
    expect(JSON.stringify(normalized)).not.toContain("INTERNAL_PAYLOAD_CANARY");
    expect(normalized.detail.title).toBe("Synthetic trace");
  });

  it("pairs completed tools, leaves unmatched calls pending, and bounds detail", async () => {
    const normalized = await normalize("rollout-2026-07-28T10-00-00-basic-session.jsonl");
    const tools = normalized.items.filter((item) => item.kind === "tool");
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
    expect(detail?.input).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(detail?.output).toHaveLength(MAX_TOOL_DETAIL_CHARS);
    expect(detail?.truncated).toBe(true);
  });

  it("chooses filename-matching metadata when duplicate metadata records exist", async () => {
    const normalized = await normalize("rollout-2026-07-28T11-00-00-child-session.jsonl");
    expect(normalized.detail.cwd).toBe("/synthetic/child");
    expect(normalized.detail.parentId).toBe("basic-session");
  });

  it("keeps valid records after a malformed middle line and marks the source partial", async () => {
    const normalized = await normalize("rollout-2026-07-28T12-00-00-malformed-session.jsonl");
    expect(normalized.items.filter((item) => item.kind === "message")).toHaveLength(2);
    expect(normalized.detail.sourceState).toBe("partial");
    expect(normalized.detail.diagnostics).toEqual([
      expect.objectContaining({ code: "malformed_json", ordinal: 3 }),
    ]);
  });
});
