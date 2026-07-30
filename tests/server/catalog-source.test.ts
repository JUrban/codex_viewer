import { cp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexSessionSource,
  createCodexSessionSource,
} from "../../src/server/codex/codex-session-source.js";
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

  it("owns rollout I/O recovery and propagates unexpected decoder failures", async () => {
    const home = await createTempDirectory("codex-adapter-errors-");
    await mkdir(join(home, "sessions"));
    await writeFile(
      join(home, "sessions/rollout-error.jsonl"),
      '{"type":"session_meta","payload":{"id":"error"}}\n',
    );
    const unavailable = new CodexSessionSource(home, "codex-errors", {
      async decode() {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    });
    const snapshot = await unavailable.refresh();
    expect(snapshot.sessions[0]?.normalized.session).toMatchObject({
      sourceState: "unavailable",
      title: "Unavailable session",
    });

    const broken = new CodexSessionSource(home, "codex-broken", {
      async decode() {
        throw new Error("decoder invariant");
      },
    });
    await expect(broken.refresh()).rejects.toThrow("decoder invariant");
  });

  it("disambiguates duplicate native IDs and exposes declared agent versions", async () => {
    const home = await createTempDirectory("codex-adapter-identities-");
    await mkdir(join(home, "sessions"), { recursive: true });
    const metadata = (title: string) =>
      JSON.stringify({
        type: "session_meta",
        payload: { id: "duplicate", title, cli_version: "2.4.0" },
      }) + "\n";
    await writeFile(join(home, "sessions/rollout-first.jsonl"), metadata("First"));
    await writeFile(join(home, "sessions/rollout-second.jsonl"), metadata("Second"));
    await writeFile(
      join(home, "sessions/rollout-no-id.jsonl"),
      '{"type":"session_meta","payload":{"title":"No ID"}}\n',
    );

    const snapshot = await new CodexSessionSource(home, "codex-identities").refresh();
    expect(snapshot.sessions).toHaveLength(3);
    expect(new Set(snapshot.sessions.map((entry) => entry.localId)).size).toBe(3);
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      code: "duplicate_native_session_id",
    }));
    expect(snapshot.sessions.find((entry) => entry.nativeSessionId === "duplicate")?.origin)
      .toMatchObject({ agentName: "Codex", agentVersion: "2.4.0" });
    expect(snapshot.sessions.find((entry) => entry.nativeSessionId === null)?.localId)
      .toBe("resource:sessions/rollout-no-id.jsonl");
    expect(snapshot.sessions.filter((entry) => entry.nativeSessionId === "duplicate")
      .map((entry) => entry.localId)
      .sort()).toEqual([
        "thread:duplicate\0resource:sessions/rollout-first.jsonl",
        "thread:duplicate\0resource:sessions/rollout-second.jsonl",
      ]);
  });

  it("keeps source identity stable when a symlinked Codex home is created later", async () => {
    const base = await createTempDirectory("codex-adapter-identity-");
    const target = join(base, "target");
    const alias = join(base, "alias");
    const configuredHome = join(alias, ".codex");
    await mkdir(target);
    await symlink(target, alias);

    const before = await createCodexSessionSource(configuredHome);
    await mkdir(join(target, ".codex"));
    const after = await createCodexSessionSource(configuredHome);

    expect(after.descriptor.instanceKey).toBe(before.descriptor.instanceKey);
    expect(after.descriptor.sourceInstanceId).toBe(
      before.descriptor.sourceInstanceId,
    );
  });
});
