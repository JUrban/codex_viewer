import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PathPolicy } from "../../src/server/adapters/codex/path-policy.js";
import { BoundedRolloutSummaryReader } from "../../src/server/adapters/codex/rollout-summary-reader.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("bounded rollout summary reader", () => {
  it("reads complete small rollouts", async () => {
    const { descriptor } = await rollout([
      JSON.stringify({ type: "session_meta", payload: { id: "small" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Hi" } }),
      "",
    ].join("\n"));

    const result = await new BoundedRolloutSummaryReader(1024).read(descriptor);

    expect(result.complete).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.bytesRead).toBe(descriptor.size);
  });

  it("bounds large rollouts and ignores the cut partial line", async () => {
    const metadata = `${JSON.stringify({
      type: "session_meta",
      payload: { id: "large", title: "Large" },
    })}\n`;
    const maximumBytes = Buffer.byteLength(metadata) + 128;
    const { descriptor } = await rollout(
      `${metadata}${JSON.stringify({ type: "response_item", payload: {
        type: "function_call_output",
        call_id: "large-output",
        output: "x".repeat(4096),
      } })}\n`,
    );

    const result = await new BoundedRolloutSummaryReader(maximumBytes).read(descriptor);

    expect(result.complete).toBe(false);
    expect(result.bytesRead).toBe(maximumBytes);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.value.type).toBe("session_meta");
  });
});

async function rollout(content: string) {
  const home = await createTempDirectory("codex-summary-reader-");
  const path = join(home, "sessions/rollout-summary.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  const descriptor = await (await PathPolicy.create(home)).register(path);
  if (descriptor === null) throw new Error("Expected a valid rollout descriptor");
  return { descriptor, home, path };
}
