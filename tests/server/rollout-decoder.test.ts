import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WholeFileRolloutDecoder } from "../../src/server/adapters/codex/rollout-decoder.js";
import { PathPolicy } from "../../src/server/adapters/codex/path-policy.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("WholeFileRolloutDecoder", () => {
  it("keeps physical ordinals, continues after malformed records, and ignores a partial tail", async () => {
    const home = await createTempDirectory("codex-decode-");
    const directory = join(home, "sessions", "2026", "07", "28");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "rollout-decoder.jsonl");
    const fixture = await readFile("tests/fixtures/codex-home/partial-tail.fragment", "utf8");
    await writeFile(path, fixture.trimEnd());
    const policy = await PathPolicy.create(home);
    const descriptor = await policy.register(path);
    expect(descriptor).not.toBeNull();

    const decoded = await new WholeFileRolloutDecoder().decode(descriptor!);
    expect(decoded.records.map((record) => [record.ordinal, record.value.type])).toEqual([
      [1, "one"],
      [3, "three"],
    ]);
    expect(decoded.diagnostics).toEqual([
      expect.objectContaining({ code: "malformed_json", ordinal: 2 }),
    ]);
    expect(decoded.incompleteTail).toBe(true);
  });

  it("keeps only the first 50 diagnostics while preserving physical ordinals", async () => {
    const home = await createTempDirectory("codex-decode-limit-");
    const directory = join(home, "sessions", "2026", "07", "28");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "rollout-decoder-limit.jsonl");
    const malformedLines = Array.from(
      { length: 60 },
      (_, index) => `malformed-${index + 1}`,
    );
    await writeFile(
      path,
      `${malformedLines.join("\n")}\n{"type":"valid"}\n`,
    );
    const policy = await PathPolicy.create(home);
    const descriptor = await policy.register(path);
    expect(descriptor).not.toBeNull();

    const decoded = await new WholeFileRolloutDecoder().decode(descriptor!);

    expect(decoded.diagnostics).toHaveLength(50);
    expect(decoded.diagnostics.map((diagnostic) => diagnostic.ordinal)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(decoded.records).toEqual([
      expect.objectContaining({ ordinal: 61, value: { type: "valid" } }),
    ]);
  });
});
