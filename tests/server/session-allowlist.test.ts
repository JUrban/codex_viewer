import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexSessionReadService } from "../../src/server/create-session-read-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("session allowlist", () => {
  it("exposes only exact relative and absolute rollout paths", async () => {
    const home = await createTempDirectory("codex-allowlist-");
    const first = join(home, "sessions/2026/08/26/rollout-first.jsonl");
    const hidden = join(home, "sessions/2026/08/26/rollout-hidden.jsonl");
    const archived = join(home, "archived_sessions/rollout-archived.jsonl");
    await Promise.all([
      rollout(first, "Allowed active"),
      rollout(hidden, "Hidden active"),
      rollout(archived, "Allowed archive"),
    ]);
    const allowlist = join(home, "allowed-sessions.txt");
    await writeFile(allowlist, [
      "# Exact paths only",
      "sessions/2026/08/26/rollout-first.jsonl",
      archived,
      "sessions/2026/08/26/rollout-first.jsonl",
      "",
    ].join("\n"));

    const repository = await createCodexSessionReadService(home, allowlist);
    const listed = await repository.list({});

    expect(listed.sessions.map(({ title }) => title).sort()).toEqual([
      "Allowed active",
      "Allowed archive",
    ]);
    expect(listed.sessions.find(({ title }) => title === "Allowed archive")?.archived)
      .toBe(true);
    expect(listed.sessions.some(({ title }) => title === "Hidden active")).toBe(false);
  });

  it("treats an empty allowlist as deny all", async () => {
    const home = await createTempDirectory("codex-allowlist-empty-");
    await rollout(join(home, "sessions/rollout-present.jsonl"), "Not exposed");
    const allowlist = join(home, "allowed-sessions.txt");
    await writeFile(allowlist, "\n# no public sessions\n");

    const repository = await createCodexSessionReadService(home, allowlist);

    await expect(repository.list({})).resolves.toMatchObject({
      sessions: [],
      total: 0,
    });
  });

  it("does not discover newly created sessions and hides entries that disappear", async () => {
    const home = await createTempDirectory("codex-allowlist-refresh-");
    const allowed = join(home, "sessions/rollout-allowed.jsonl");
    await rollout(allowed, "Allowed");
    const allowlist = join(home, "allowed-sessions.txt");
    await writeFile(allowlist, "sessions/rollout-allowed.jsonl\n");
    const repository = await createCodexSessionReadService(home, allowlist);

    await rollout(join(home, "sessions/rollout-later.jsonl"), "Not allowed later");
    await repository.refresh();
    expect((await repository.list({})).sessions.map(({ title }) => title))
      .toEqual(["Allowed"]);

    await unlink(allowed);
    await repository.refresh();
    const missing = await repository.list({});
    expect(missing.sessions).toEqual([]);
    expect(missing.diagnostics).toEqual([
      expect.objectContaining({ code: "session_allowlist_entry_unavailable" }),
    ]);
  });

  it("fails closed for unreadable, unsafe, and non-rollout entries", async () => {
    const home = await createTempDirectory("codex-allowlist-invalid-");
    const allowed = join(home, "sessions/rollout-allowed.jsonl");
    await rollout(allowed, "Allowed");

    await expect(createCodexSessionReadService(
      home,
      join(home, "missing-allowlist.txt"),
    )).rejects.toThrow("Could not read session allowlist");

    const outsideHome = await createTempDirectory("codex-allowlist-outside-");
    const outside = join(outsideHome, "rollout-outside.jsonl");
    await rollout(outside, "Outside");
    const unsafeAllowlist = join(home, "unsafe.txt");
    await writeFile(unsafeAllowlist, outside);
    await expect(createCodexSessionReadService(home, unsafeAllowlist))
      .rejects.toThrow("line 1 must name an existing rollout file");

    const link = join(home, "sessions/rollout-link.jsonl");
    await symlink(allowed, link);
    const linkAllowlist = join(home, "symlink.txt");
    await writeFile(linkAllowlist, "sessions/rollout-link.jsonl\n");
    await expect(createCodexSessionReadService(home, linkAllowlist))
      .rejects.toThrow("line 1 must name an existing rollout file");

    const ordinary = join(home, "sessions/not-a-rollout.jsonl");
    await writeFile(ordinary, "{}\n");
    const ordinaryAllowlist = join(home, "ordinary.txt");
    await writeFile(ordinaryAllowlist, "sessions/not-a-rollout.jsonl\n");
    await expect(createCodexSessionReadService(home, ordinaryAllowlist))
      .rejects.toThrow("line 1 must name an existing rollout file");
  });
});

async function rollout(path: string, title: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      timestamp: "2026-08-26T00:00:00Z",
      type: "session_meta",
      payload: { id: title.toLowerCase().replaceAll(" ", "-"), title },
    })}\n`,
  );
}
