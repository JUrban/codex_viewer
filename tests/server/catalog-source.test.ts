import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CompositeCatalogSource } from "../../src/server/codex/catalog-source.js";
import { JsonlCatalogSource } from "../../src/server/codex/jsonl-catalog-source.js";
import { SqliteCatalogSource } from "../../src/server/codex/sqlite-catalog-source.js";
import { PathPolicy } from "../../src/server/security/path-policy.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

describe("catalog discovery", () => {
  it("falls back from incompatible SQLite and scans only allowlisted JSONL roots", async () => {
    const home = await createTempDirectory("codex-catalog-");
    await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
    const policy = await PathPolicy.create(home);
    const source = new CompositeCatalogSource(
      new JsonlCatalogSource(policy),
      new SqliteCatalogSource(home, policy),
    );

    const discovery = await source.discover();
    expect(discovery.mode).toBe("jsonl");
    expect(discovery.entries).toHaveLength(4);
    expect(discovery.entries.filter((entry) => entry.descriptor.archived)).toHaveLength(1);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({ code: "sqlite_unavailable", severity: "warning" }),
    ]);
    expect(JSON.stringify(discovery.diagnostics)).not.toContain(home);
  });

  it("feature-detects a lower compatible database when a newer state file is corrupt", async () => {
    const home = await createTempDirectory("codex-catalog-sqlite-");
    await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
    const database = new DatabaseSync(join(home, "state_50.sqlite"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        parent_thread_id TEXT,
        archived INTEGER,
        agent_nickname TEXT,
        agent_role TEXT,
        agent_path TEXT,
        thread_source TEXT
      )
    `);
    database.prepare(
      "INSERT INTO threads (id, rollout_path, title, cwd, parent_thread_id, archived, " +
      "agent_nickname, agent_role, agent_path, thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "basic-session",
      join(home, "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl"),
      "Title from SQLite",
      "/synthetic/sqlite-project",
      null,
      0,
      "Ada",
      "reviewer",
      "/root/sqlite_review",
      "subagent",
    );
    database.close();

    const policy = await PathPolicy.create(home);
    const source = new CompositeCatalogSource(
      new JsonlCatalogSource(policy),
      new SqliteCatalogSource(home, policy),
    );
    const discovery = await source.discover();
    expect(discovery.mode).toBe("sqlite+jsonl");
    expect(discovery.entries).toHaveLength(4);
    expect(discovery.entries.find((entry) => entry.metadata?.threadId === "basic-session")?.metadata)
      .toEqual(expect.objectContaining({
        title: "Title from SQLite",
        cwd: "/synthetic/sqlite-project",
        agent: {
          taskName: "sqlite_review",
          nickname: "Ada",
          role: "reviewer",
        },
      }));
    expect(discovery.diagnostics).toEqual([]);
  });

  it("does not treat the user thread source as an agent role", async () => {
    const home = await createTempDirectory("codex-catalog-user-source-");
    await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
    const database = new DatabaseSync(join(home, "state_50.sqlite"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        agent_nickname TEXT,
        agent_role TEXT,
        agent_path TEXT,
        thread_source TEXT
      )
    `);
    database.prepare(
      "INSERT INTO threads (id, rollout_path, agent_nickname, agent_role, agent_path, thread_source) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "basic-session",
      join(home, "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl"),
      null,
      null,
      null,
      "user",
    );
    database.close();

    const policy = await PathPolicy.create(home);
    const discovery = await new SqliteCatalogSource(home, policy).discover();
    expect(discovery.compatible).toBe(true);
    expect(discovery.entries).toHaveLength(1);
    expect(discovery.entries[0]?.metadata?.agent).toBeNull();
  });
});
