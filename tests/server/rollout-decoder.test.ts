import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
    expect(decoded).not.toHaveProperty("incompleteTail");
  });

  it.each([
    ["ordinary", Buffer.from("ordinary tail")],
    ["whitespace", Buffer.from("   \t\r")],
    ["valid JSON", Buffer.from('{"type":"pending"}')],
    ["non-object JSON", Buffer.from("[]")],
    ["partial UTF-8", Buffer.from([0xe2, 0x82])],
  ])("silently ignores an unterminated %s tail", async (_label, tail) => {
    const { path, descriptor } = await rollout("silent-tail", Buffer.concat([
      Buffer.from('{"type":"committed"}\n'),
      tail,
    ]));
    const decoder = new WholeFileRolloutDecoder();
    const before = await decoder.decode(descriptor);
    expect(before.records.map((record) => record.value.type)).toEqual(["committed"]);
    expect(before.diagnostics).toEqual([]);

    await appendFile(path, "\n");
    const after = await decoder.decode(descriptor);
    if (_label === "valid JSON") {
      expect(after.records.map((record) => record.value.type)).toEqual([
        "committed",
        "pending",
      ]);
      expect(after.diagnostics).toEqual([]);
    } else if (_label === "non-object JSON") {
      expect(after.diagnostics).toEqual([
        expect.objectContaining({ code: "invalid_record", ordinal: 2 }),
      ]);
    } else if (_label !== "whitespace") {
      expect(after.diagnostics).toEqual([
        expect.objectContaining({ code: "malformed_json", ordinal: 2 }),
      ]);
    }
  });

  it("warns about an oversized line only after its terminating newline arrives", async () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x78);
    const { path, descriptor } = await rollout("oversized-tail", oversized);
    const decoder = new WholeFileRolloutDecoder();

    expect((await decoder.decode(descriptor)).diagnostics).toEqual([]);
    await appendFile(path, "\n");
    expect((await decoder.decode(descriptor)).diagnostics).toEqual([
      expect.objectContaining({ code: "line_too_large", ordinal: 1 }),
    ]);
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

async function rollout(name: string, contents: string | Uint8Array) {
  const home = await createTempDirectory(`codex-${name}-`);
  const directory = join(home, "sessions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-${name}.jsonl`);
  await writeFile(path, contents);
  const policy = await PathPolicy.create(home);
  const descriptor = await policy.register(path);
  if (descriptor === null) throw new Error("Fixture path was rejected");
  return { path, descriptor };
}
