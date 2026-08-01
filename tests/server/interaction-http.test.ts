import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import type { SessionRepository } from "../../src/server/repository/session-repository.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const SESSION_ID = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789";
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start() {
  const clientDirectory = await createTempDirectory("codex-interaction-http-");
  await writeFile(join(clientDirectory, "index.html"), "viewer");
  const unavailable = async () => null;
  const repository: SessionRepository = {
    list: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ context: { source: "detail" } }),
    getItems: unavailable,
    getToolDetail: unavailable,
    getDirectiveDetail: unavailable,
    getInteractionSession: unavailable,
    refresh: vi.fn(),
  };
  const interaction = {
    describe: vi.fn().mockResolvedValue({
      supported: true,
      state: "idle",
      activation: "activate",
      canSendMessage: true,
      canInterrupt: false,
      canSendEscape: true,
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    escape: vi.fn().mockResolvedValue(undefined),
  };
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    codexHome: "/unused",
    clientDirectory,
    tls: { enabled: false },
    interactionEnabled: true,
  };
  const server = createServer(config, createApiRouter(repository, { interaction }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://${LOOPBACK_HOST}:${port}`, interaction };
}

describe("interaction HTTP API", () => {
  it("includes state in session reads, removes the standalone GET, and accepts messages", async () => {
    const { base, interaction } = await start();
    const detail = await fetch(`${base}/api/v1/sessions/${SESSION_ID}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(expect.objectContaining({
      interaction: expect.objectContaining({ supported: true, state: "idle" }),
    }));
    expect((await fetch(
      `${base}/api/v1/sessions/${SESSION_ID}/interaction`,
    )).status).toBe(404);

    const message = "first\r\nsecond 🌊";
    const sent = await fetch(`${base}/api/v1/sessions/${SESSION_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    expect(sent.status).toBe(204);
    expect(interaction.sendMessage).toHaveBeenCalledWith(SESSION_ID, message);
  });

  it("validates message and key bodies including the 64 KiB boundary", async () => {
    const { base, interaction } = await start();
    const postMessage = (message: string) => fetch(
      `${base}/api/v1/sessions/${SESSION_ID}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );
    expect((await postMessage(" \n ")).status).toBe(400);
    expect((await postMessage("a".repeat(65_536))).status).toBe(204);
    expect((await postMessage("a".repeat(65_537))).status).toBe(400);
    expect(interaction.sendMessage).toHaveBeenCalledTimes(1);

    const invalidKey = await fetch(`${base}/api/v1/sessions/${SESSION_ID}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "enter" }),
    });
    expect(invalidKey.status).toBe(400);
    const escape = await fetch(`${base}/api/v1/sessions/${SESSION_ID}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "escape" }),
    });
    expect(escape.status).toBe(204);
    expect(interaction.escape).toHaveBeenCalledWith(SESSION_ID);
  });

  it("allows POST only on the declared interaction routes", async () => {
    const { base } = await start();
    expect((await fetch(base, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/sessions`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/sessions/${SESSION_ID}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/unknown`, { method: "POST" })).status).toBe(405);
  });
});
