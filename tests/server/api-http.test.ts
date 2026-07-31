import { cp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import { createCodexSessionRepository } from "../../src/server/create-session-repository.js";
import type { SessionReadCursor } from "../../src/shared/api-contract.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const servers: ReturnType<typeof createServer>[] = [];

function cursorQuery(cursor: SessionReadCursor): string {
  return new URLSearchParams({
    sessionRevision: cursor.sessionRevision,
    throughOrdinal: String(cursor.throughOrdinal),
    timelinePrefixRevision: cursor.timelinePrefixRevision,
  }).toString();
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
});

async function startApi(maxScannedBytes?: number) {
  const home = await createTempDirectory("codex-api-home-");
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  const clientDirectory = await createTempDirectory("codex-api-client-");
  await writeFile(join(clientDirectory, "index.html"), "<h1>trace notebook</h1>");
  const repository = await createCodexSessionRepository(
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
  it("does not expose a status endpoint", async () => {
    const { base } = await startApi();
    const response = await fetch(`${base}/api/v1/status`);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: "not_found" }),
    }));
  });

  it("serves list, detail, paged items, and lazy tool detail", async () => {
    const { base } = await startApi();
    const listResponse = await fetch(`${base}/api/v1/sessions?q=synthetic&limit=10`);
    const list = await listResponse.json();
    expect(list).toEqual(expect.objectContaining({
      listRevision: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      total: expect.any(Number),
      hasMore: false,
      nextOffset: null,
    }));
    const basic = list.sessions.find(
      (entry: { session: { title: string } }) => entry.session.title === "Synthetic trace",
    );
    expect(basic.session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(basic.session.sourceId).toBeUndefined();
    expect(basic.session.origin).toEqual({
      sourceType: "codex-jsonl",
      sourceInstanceId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      agentName: "Codex",
      agentVersion: null,
      formatVersion: null,
    });
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
    expect(detail.context.session.title).toBe("Synthetic trace");
    expect(detail.context.session.sourceId).toBe("basic-session");
    expect(detail.context.session.origin).toEqual(basic.session.origin);
    expect(detail.context.session.itemCount).toBeGreaterThan(5);
    expect(detail.context.cursor.sessionRevision).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(detail.context.cursor.throughOrdinal).toBe(0);

    const firstPageResponse = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=3` +
      `&${cursorQuery(detail.context.cursor)}`,
    );
    const firstPage = await firstPageResponse.json();
    expect(firstPage.items).toHaveLength(3);
    expect(firstPage.context.hasMore).toBe(true);
    expect(firstPage.context.cursor.throughOrdinal).toBe(firstPage.items.at(-1).ordinal);
    expect(firstPage.context.cursor.timelinePrefixRevision)
      .toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(firstPage.items.every(
      (item: Record<string, unknown>) =>
        !("timelinePrefixRevision" in item),
    )).toBe(true);
    const secondPage = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=3` +
      `&${cursorQuery(firstPage.context.cursor)}`,
    );
    expect(secondPage.status).toBe(200);

    const allItems = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=512` +
      `&${cursorQuery(detail.context.cursor)}`,
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
      `?${cursorQuery(allItems.context.cursor)}`,
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
    const missingRevision = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items/${tool.id}/tool`,
    );
    expect(missingRevision.status).toBe(400);
    const toolResponse = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items/${tool.id}/tool` +
      `?${cursorQuery(allItems.context.cursor)}`,
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
    const detail = await fetch(`${base}/api/v1/sessions/${basic.session.id}`)
      .then((response) => response.json());
    const page = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=2` +
      `&${cursorQuery(detail.context.cursor)}`,
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
    const migrated = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}` +
      `?${cursorQuery(page.context.cursor)}`,
    );
    expect(migrated.status).toBe(200);
    const migratedBody = await migrated.json();
    expect(migratedBody.context.cursor.sessionRevision)
      .not.toBe(page.context.cursor.sessionRevision);
    expect(migratedBody.context.cursor.throughOrdinal)
      .toBe(page.context.cursor.throughOrdinal);
    expect(migratedBody.context.hasMore).toBe(true);
    const following = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=2` +
      `&${cursorQuery(page.context.cursor)}`,
    );
    expect(following.status).toBe(200);
    expect((await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items/continuity`,
    )).status).toBe(404);
    expect((await fetch(
      `${base}/api/v1/sessions/${basic.session.id}` +
      `?sessionRevision=${page.context.cursor.sessionRevision}`,
    )).status).toBe(400);
    expect((await fetch(
      `${base}/api/v1/sessions/${basic.session.id}` +
      `?sessionRevision=${page.context.cursor.sessionRevision}` +
      `&throughOrdinal=${page.context.cursor.throughOrdinal}` +
      `&timelinePrefixRevision=short`,
    )).status).toBe(400);
    const beyondEnd = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}` +
      `?sessionRevision=${page.context.cursor.sessionRevision}` +
      `&throughOrdinal=999999` +
      `&timelinePrefixRevision=${page.context.cursor.timelinePrefixRevision}`,
    );
    expect(beyondEnd.status).toBe(409);
    expect((await beyondEnd.json()).error.code).toBe(
      "stale_timeline_prefix",
    );

    const staleList = await fetch(
      `${base}/api/v1/sessions?archiveScope=all&offset=1&limit=1` +
      `&listRevision=${list.listRevision}`,
    );
    expect(staleList.status).toBe(409);
    expect((await staleList.json()).error.code)
      .toBe("stale_list_revision");

    const canary = "PRIVATE_QUERY_CANARY_".repeat(20);
    const invalid = await fetch(`${base}/api/v1/sessions?q=${canary}`);
    expect(invalid.status).toBe(400);
    const body = await invalid.text();
    expect(body).not.toContain(canary);
    expect(JSON.parse(body).error.code).toBe("invalid_query");
    expect((await fetch(`${base}/api/v1/sessions?archiveScope=maybe`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/sessions?offset=1`)).status).toBe(400);
    expect((await fetch(
      `${base}/api/v1/sessions?offset=1&listRevision=short`,
    )).status).toBe(400);
    const mismatchedFirstPage = await fetch(
      `${base}/api/v1/sessions?listRevision=${"x".repeat(32)}`,
    );
    expect(mismatchedFirstPage.status).toBe(409);
    expect((await mismatchedFirstPage.json()).error.code)
      .toBe("stale_list_revision");
    const itemsUrl = `${base}/api/v1/sessions/${basic.session.id}/items`;
    expect((await fetch(`${itemsUrl}?limit=2`)).status).toBe(400);
    expect((await fetch(
      `${itemsUrl}?sessionRevision=short`,
    )).status).toBe(400);
    expect((await fetch(
      `${itemsUrl}?sessionRevision=${detail.context.cursor.sessionRevision}` +
      `&sessionRevision=${detail.context.cursor.sessionRevision}`,
    )).status).toBe(400);
    expect((await fetch(
      `${itemsUrl}?limit=513&${cursorQuery(detail.context.cursor)}`,
    )).status).toBe(400);
    expect((await fetch(`${base}/api/v1/sessions/not-valid`)).status).toBe(404);
  });

  it("keeps one session revision valid across an unrelated rollout change", async () => {
    const { base, home, repository } = await startApi();
    const list = await fetch(`${base}/api/v1/sessions?archiveScope=all`)
      .then((response) => response.json());
    const basic = list.sessions.find(
      (entry: { session: { title: string } }) =>
        entry.session.title === "Synthetic trace",
    );
    const detail = await fetch(`${base}/api/v1/sessions/${basic.session.id}`)
      .then((response) => response.json());
    const first = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=2` +
      `&${cursorQuery(detail.context.cursor)}`,
    ).then((response) => response.json());

    const unrelated = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T12-00-00-malformed-session.jsonl",
    );
    await writeFile(
      unrelated,
      `${await readFile(unrelated, "utf8")}` +
      '{"timestamp":"2026-07-28T12:00:10.000Z","type":"response_item",' +
      '"payload":{"type":"message","role":"assistant","content":' +
      '[{"type":"output_text","text":"unrelated"}]}}\n',
    );
    await repository.refresh();

    const refreshedList = await fetch(`${base}/api/v1/sessions?archiveScope=all`)
      .then((response) => response.json());
    expect(refreshedList.listRevision).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=2` +
      `&${cursorQuery(first.context.cursor)}`,
    )).status).toBe(200);

    const allItems = await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items?limit=512` +
      `&${cursorQuery(detail.context.cursor)}`,
    ).then((response) => response.json());
    const directive = allItems.items.find(
      (item: { kind: string }) => item.kind === "directive",
    );
    expect((await fetch(
      `${base}/api/v1/sessions/${basic.session.id}/items/${directive.id}/directive` +
      `?${cursorQuery(allItems.context.cursor)}`,
    )).status).toBe(200);
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
