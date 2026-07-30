import { cp, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlCatalogSource } from "../../src/server/codex/jsonl-catalog-source.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("catalog discovery", () => {
  it("scans only allowlisted JSONL roots", async () => {
    const home = await createTempDirectory("codex-catalog-");
    await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
    await writeFile(join(home, "sessions/not-a-rollout.jsonl"), "{}\n");
    await writeFile(join(home, "rollout-outside-root.jsonl"), "{}\n");
    const policy = await PathPolicy.create(home);

    const discovery = await new JsonlCatalogSource(policy).discover();

    expect(discovery.entries).toHaveLength(4);
    expect(discovery.entries.filter((entry) => entry.descriptor.archived)).toHaveLength(1);
    expect(discovery.entries.every((entry) =>
      entry.descriptor.canonicalPath.includes("/sessions/") ||
      entry.descriptor.canonicalPath.includes("/archived_sessions/")
    )).toBe(true);
    expect(discovery.diagnostics).toEqual([]);
  });

  it("degrades safely when allowlisted roots are absent or become unreadable", async () => {
    const emptyHome = await createTempDirectory("codex-catalog-empty-");
    const empty = await new JsonlCatalogSource(
      await PathPolicy.create(emptyHome),
    ).discover();
    expect(empty).toEqual({ entries: [], diagnostics: [] });

    const changedHome = await createTempDirectory("codex-catalog-changed-");
    const sessions = join(changedHome, "sessions");
    await mkdir(sessions);
    const policy = await PathPolicy.create(changedHome);
    await rename(sessions, join(changedHome, "sessions-moved"));

    const changed = await new JsonlCatalogSource(policy).discover();
    expect(changed.entries).toEqual([]);
    expect(changed.diagnostics).toEqual([
      expect.objectContaining({
        code: "session_root_unreadable",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(changed.diagnostics)).not.toContain(changedHome);
  });
});
