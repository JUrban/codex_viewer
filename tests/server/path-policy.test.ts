import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { opaqueIdForPath, OpaqueIdRegistry } from "../../src/server/security/opaque-id.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("PathPolicy", () => {
  it("registers only canonical regular rollouts inside explicit roots", async () => {
    const home = await createTempDirectory("codex-policy-");
    const sessions = join(home, "sessions", "2026", "07", "28");
    await mkdir(sessions, { recursive: true });
    const valid = join(sessions, "rollout-safe.jsonl");
    const invalidName = join(sessions, "notes.jsonl");
    const outside = join(home, "outside.jsonl");
    await writeFile(valid, "{}\n");
    await writeFile(invalidName, "{}\n");
    await writeFile(outside, "{}\n");
    const escape = join(sessions, "rollout-escape.jsonl");
    await symlink(outside, escape);

    const policy = await PathPolicy.create(home);
    const descriptor = await policy.register(valid);
    const canonical = await realpath(valid);
    expect(descriptor?.canonicalPath).toBe(canonical);
    expect(descriptor?.id).toBe(opaqueIdForPath(canonical));
    expect(await policy.register(invalidName)).toBeNull();
    expect(await policy.register(outside)).toBeNull();
    expect(await policy.register(escape)).toBeNull();
    expect(await policy.register(join(sessions, "..", "..", "..", "outside.jsonl"))).toBeNull();
  });

  it("rejects an opaque ID collision instead of replacing the first value", () => {
    const registry = new OpaqueIdRegistry<string>(() => "forced-collision");
    const first = registry.register("/canonical/a", "first");
    expect(registry.get(first)).toBe("first");
    expect(() => registry.register("/canonical/b", "second")).toThrow("collision");
    expect(registry.get(first)).toBe("first");
  });
});
