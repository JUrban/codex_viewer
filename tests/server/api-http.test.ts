import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import { createSessionRepository } from "../../src/server/repository/create-session-repository.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
});

async function startApi(maxScannedBytes?: number, sqlite = false) {
  const home = await mkdtemp(join(tmpdir(), "codex-api-home-"));
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  if (sqlite) {
    const database = new DatabaseSync(join(home, "state_50.sqlite"));
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        archived INTEGER
      )
    `);
    database.prepare(
      "INSERT INTO threads (id, rollout_path, title, cwd, archived) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "basic-session",
      join(home, "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl"),
      "SQLite API title",
      "/synthetic/sqlite-api",
      0,
    );
    database.close();
  }
  const clientDirectory = await mkdtemp(join(tmpdir(), "codex-api-client-"));
  await writeFile(join(clientDirectory, "index.html"), "<h1>trace notebook</h1>");
  const repository = await createSessionRepository(
    home,
    !sqlite,
    maxScannedBytes === undefined
      ? undefined
      : { maxScannedBytes, maxResults: 200, maxExcerptChars: 240, maxDurationMs: 1_000 },
  );
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    codexHome: home,
    clientDirectory,
  };
  const server = createServer(config, createApiRouter(repository));
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, LOOPBACK_HOST, resolveListen));
  const { port } = server.address() as AddressInfo;
  return { base: `http://${LOOPBACK_HOST}:${port}`, home };
}

describe("versioned session API", () => {
  it("serves status, list, detail, paged items, and lazy tool detail", async () => {
    const { base } = await startApi();
    const status = await fetch(`${base}/api/v1/status`);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual(expect.objectContaining({
      available: true,
      catalogMode: "jsonl",
      generation: 1,
      sessionCount: 4,
    }));

    const listResponse = await fetch(`${base}/api/v1/sessions?q=synthetic&limit=10`);
    const list = await listResponse.json();
    const basic = list.sessions.find(
      (entry: { session: { title: string } }) => entry.session.title === "Synthetic trace",
    );
    expect(basic.session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(list)).not.toContain("DEVELOPER_CANARY_NEVER_RENDER");

    const detailResponse = await fetch(`${base}/api/v1/sessions/${basic.session.id}`);
    const detail = await detailResponse.json();
    expect(detail.session.title).toBe("Synthetic trace");
    expect(detail.session.itemCount).toBeGreaterThan(5);

    const firstPageResponse = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=3&view=internal`,
    );
    const firstPage = await firstPageResponse.json();
    expect(firstPage.items).toHaveLength(3);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=3&view=internal` +
      `&afterOrdinal=${firstPage.nextAfterOrdinal}&generation=${firstPage.generation}`,
    );
    expect(secondPage.status).toBe(200);

    const allItems = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=200&view=internal`,
    ).then((response) => response.json());
    const tool = allItems.items.find((item: { kind: string }) => item.kind === "tool");
    const missingGeneration = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items/${tool.id}/tool`,
    );
    expect(missingGeneration.status).toBe(400);
    const toolResponse = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items/${tool.id}/tool` +
      `?generation=${allItems.generation}`,
    );
    expect(toolResponse.headers.get("content-type")).toContain("application/json");
    expect(await toolResponse.json()).toEqual(expect.objectContaining({
      sessionId: basic.session.id,
      itemId: tool.id,
      output: "synthetic result",
    }));
  });

  it("rejects invalid queries safely and reports a stale snapshot cursor after file change", async () => {
    const { base, home } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions`).then((response) => response.json());
    const basic = list.sessions.find(
      (entry: { session: { title: string } }) => entry.session.title === "Synthetic trace",
    );
    const page = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=2`,
    ).then((response) => response.json());

    const rollout = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    const previous = await readFile(rollout, "utf8");
    await writeFile(
      rollout,
      `${previous}{"timestamp":"2026-07-28T10:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"new"}]}}\n`,
    );
    const stale = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?afterOrdinal=${page.nextAfterOrdinal}` +
      `&generation=${page.generation}`,
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("stale_generation");

    const canary = "PRIVATE_QUERY_CANARY_".repeat(20);
    const invalid = await fetch(`${base}/api/v1/sessions?q=${canary}`);
    expect(invalid.status).toBe(400);
    const body = await invalid.text();
    expect(body).not.toContain(canary);
    expect(JSON.parse(body).error.code).toBe("invalid_query");
    expect((await fetch(`${base}/api/v1/sessions?archived=maybe`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/sessions/not-valid`)).status).toBe(404);
  });

  it("reports bounded search as partial without exposing source paths", async () => {
    const { base, home } = await startApi(1);
    const response = await fetch(`${base}/api/v1/sessions?q=synthetic`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.warnings).toEqual([
      expect.objectContaining({ code: "search_byte_budget" }),
    ]);
    expect(JSON.stringify(body)).not.toContain(home);
  });

  it("publishes feature-detected SQLite metadata through the same safe API", async () => {
    const { base } = await startApi(undefined, true);
    const status = await fetch(`${base}/api/v1/status`).then((response) => response.json());
    expect(status.catalogMode).toBe("sqlite+jsonl");
    const list = await fetch(`${base}/api/v1/sessions?q=SQLite%20API%20title`)
      .then((response) => response.json());
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].session).toEqual(expect.objectContaining({
      title: "SQLite API title",
      cwd: "/synthetic/sqlite-api",
    }));
  });
});
