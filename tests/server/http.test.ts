import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import type { SessionRepository } from "../../src/server/repository/session-repository.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start() {
  const clientDirectory = await createTempDirectory("codex-reader-client-");
  await writeFile(join(clientDirectory, "index.html"), "<h1>trace notebook</h1>");
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    codexHome: "/unused",
    clientDirectory,
  };
  const server = createServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://${LOOPBACK_HOST}:${port}`;
}

async function startWithRepository(repository: SessionRepository, logger: {
  error(message: string, context: { readonly requestId: string; readonly error: unknown }): void;
}) {
  const clientDirectory = await createTempDirectory("codex-reader-api-client-");
  await writeFile(join(clientDirectory, "index.html"), "<h1>trace notebook</h1>");
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    codexHome: "/unused",
    clientDirectory,
  };
  const server = createServer(
    config,
    createApiRouter(repository, {
      logger,
      requestId: () => "request-fixture",
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://${LOOPBACK_HOST}:${port}`;
}

async function rawStatus(base: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(base);
  return await new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        host: url.hostname,
        port: url.port,
        headers: { Connection: "close", ...headers },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("secure HTTP foundation", () => {
  it("uses loopback by default and accepts a configured listen host", () => {
    expect(loadConfig({}).host).toBe(LOOPBACK_HOST);
    expect(loadConfig({ CODEX_VIEWER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(() => loadConfig({ CODEX_VIEWER_HOST: " " })).toThrow(
      "CODEX_VIEWER_HOST must not be empty",
    );
  });

  it("serves the SPA with restrictive headers and no CORS", async () => {
    const base = await start();
    const response = await fetch(`${base}/session/fixture`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("trace notebook");
    const contentSecurityPolicy = response.headers.get("content-security-policy");
    expect(contentSecurityPolicy).toContain("default-src 'self'");
    expect(contentSecurityPolicy).toContain("font-src 'self' data:");
    expect(contentSecurityPolicy).toContain("style-src 'self'");
    expect(contentSecurityPolicy).toContain("style-src-attr 'unsafe-inline'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("accepts forwarded Host and Origin headers but rejects mutation methods", async () => {
    const base = await start();
    expect(await rawStatus(base, { Host: "reader.example" })).toBe(200);
    expect(await rawStatus(base, {
      Host: "reader.example",
      Origin: "https://dashboard.example",
    })).toBe(200);
    const post = await fetch(base, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("does not let the SPA fallback shadow API routes", async () => {
    const base = await start();
    const response = await fetch(`${base}/api/v1/status`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("logs internal API failures and returns only an opaque request ID", async () => {
    const failure = new Error("PRIVATE_INTERNAL_FAILURE");
    const fail = async (): Promise<never> => {
      throw failure;
    };
    const repository: SessionRepository = {
      getStatus: fail,
      list: fail,
      getSession: fail,
      getItems: fail,
      getToolDetail: fail,
      getDirectiveDetail: fail,
      refresh: fail,
    };
    const logger = { error: vi.fn() };
    const base = await startWithRepository(repository, logger);

    const response = await fetch(`${base}/api/v1/status`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "The local session reader could not complete the request",
        requestId: "request-fixture",
      },
    });
    expect(JSON.stringify(body)).not.toContain(failure.message);
    expect(logger.error).toHaveBeenCalledWith(
      "Session API request failed",
      { requestId: "request-fixture", error: failure },
    );
  });
});
