import { cp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import { createSessionRepository } from "../../src/server/repository/create-session-repository.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
});

async function startApi(maxScannedBytes?: number) {
  const home = await createTempDirectory("codex-api-home-");
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  const clientDirectory = await createTempDirectory("codex-api-client-");
  await writeFile(join(clientDirectory, "index.html"), "<h1>trace notebook</h1>");
  const repository = await createSessionRepository(
    home,
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
  return { base: `http://${LOOPBACK_HOST}:${port}`, home, repository };
}

describe("versioned session API", () => {
  it("serves status, list, detail, paged items, and lazy tool detail", async () => {
    const { base } = await startApi();
    const status = await fetch(`${base}/api/v1/status`);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const statusBody = await status.json();
    expect(statusBody).toEqual(expect.objectContaining({
      available: true,
      generation: 1,
      sessionCount: 4,
    }));
    expect(statusBody).not.toHaveProperty("catalogMode");

    const listResponse = await fetch(`${base}/api/v1/sessions?q=synthetic&limit=10`);
    const list = await listResponse.json();
    expect(list).toEqual(expect.objectContaining({
      total: expect.any(Number),
      hasMore: false,
      nextOffset: null,
    }));
    const basic = list.sessions.find(
      (entry: { session: { title: string } }) => entry.session.title === "Synthetic trace",
    );
    expect(basic.session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(basic.session.sourceId).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain("DEVELOPER_DIRECTIVE_CANARY");

    const agentSearch = await fetch(`${base}/api/v1/sessions?q=widget_review`)
      .then((response) => response.json());
    expect(agentSearch.sessions).toHaveLength(1);
    expect(agentSearch.sessions[0].session.agent).toEqual({
      taskName: "widget_review",
      nickname: "Sagan",
      role: "reviewer",
    });
    expect(agentSearch.sessions[0].matches[0].field).toBe("title");

    const active = await fetch(`${base}/api/v1/sessions?archiveScope=active`)
      .then((response) => response.json());
    const archived = await fetch(`${base}/api/v1/sessions?archiveScope=archived`)
      .then((response) => response.json());
    const all = await fetch(`${base}/api/v1/sessions?archiveScope=all`)
      .then((response) => response.json());
    expect(active.sessions.every(
      (entry: { session: { archived: boolean } }) => !entry.session.archived,
    )).toBe(true);
    expect(archived.sessions).toHaveLength(1);
    expect(archived.sessions[0].session.archived).toBe(true);
    expect(all.total).toBe(active.total + archived.total);

    const detailResponse = await fetch(`${base}/api/v1/sessions/${basic.session.id}`);
    const detail = await detailResponse.json();
    expect(detail.session.title).toBe("Synthetic trace");
    expect(detail.session.sourceId).toBe("basic-session");
    expect(detail.session.itemCount).toBeGreaterThan(5);

    const firstPageResponse = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=3`,
    );
    const firstPage = await firstPageResponse.json();
    expect(firstPage.items).toHaveLength(3);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=3` +
      `&afterOrdinal=${firstPage.nextAfterOrdinal}&generation=${firstPage.generation}`,
    );
    expect(secondPage.status).toBe(200);

    const allItems = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=512`,
    ).then((response) => response.json());
    expect(JSON.stringify(allItems)).not.toContain("DIRECTIVE_DETAIL_CANARY");
    expect(JSON.stringify(allItems)).not.toContain("REASONING_CANARY_NEVER_RENDER");
    expect(allItems.items.some((item: { kind: string }) => item.kind === "reasoning"))
      .toBe(false);
    expect(allItems.items.find((item: { kind: string; eventType?: string }) =>
      item.kind === "internal" && item.eventType === "reasoning"
    )).toEqual(expect.objectContaining({
      id: "internal-6",
      summary: "REASONING_SUMMARY_CANARY",
    }));
    const directive = allItems.items.find((item: { kind: string }) => item.kind === "directive");
    expect((await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items/${directive.id}/directive`,
    )).status).toBe(400);
    const directiveResponse = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items/${directive.id}/directive` +
      `?generation=${allItems.generation}`,
    );
    expect(directiveResponse.status).toBe(200);
    expect(await directiveResponse.json()).toEqual(expect.objectContaining({
      sessionId: basic.session.id,
      itemId: directive.id,
      text: expect.stringContaining("DIRECTIVE_DETAIL_CANARY"),
      truncated: false,
    }));
    const developerDirective = allItems.items.find(
      (item: { id: string }) => item.id === "directive-5",
    );
    expect(developerDirective).toEqual(expect.objectContaining({
      kind: "directive",
      summary: "DEVELOPER_DIRECTIVE_CANARY",
    }));
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
    const { base, home, repository } = await startApi();
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
    await repository.refresh();
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
    expect((await fetch(`${base}/api/v1/sessions?archived=true`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/sessions?archiveScope=maybe`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/sessions?offset=1`)).status).toBe(400);
    expect((await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=513`,
    )).status).toBe(400);
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

});
