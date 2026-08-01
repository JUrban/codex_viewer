import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { request as secureRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOPBACK_HOST, type ServerConfig } from "../../src/server/config.js";
import { createApiRouter } from "../../src/server/http/api-router.js";
import { createServer } from "../../src/server/http/create-server.js";
import type { SessionRepository } from "../../src/server/repository/session-repository.js";
import { createTempDirectory } from "../helpers/temp-directories.js";
import {
  TEST_CA,
  TEST_CLIENT_CERTIFICATE,
  TEST_CLIENT_KEY,
  TEST_SERVER_CERTIFICATE,
  TEST_SERVER_KEY,
  TEST_UNTRUSTED_CLIENT_CERTIFICATE,
  TEST_UNTRUSTED_CLIENT_KEY,
} from "./tls-fixtures.js";

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
    tls: { enabled: false },
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
    tls: { enabled: false },
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

async function secureStatus(
  base: string,
  client?: { readonly certificate: string; readonly key: string },
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const outgoing = secureRequest(
      base,
      {
        ca: TEST_CA,
        cert: client?.certificate,
        key: client?.key,
        agent: false,
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

async function startSecure(requireClientCertificate: boolean): Promise<string> {
  const directory = await createTempDirectory("codex-reader-tls-");
  const clientDirectory = join(directory, "client");
  const certificatePath = join(directory, "server.pem");
  const privateKeyPath = join(directory, "server-key.pem");
  const certificateAuthorityPath = join(directory, "ca.pem");
  await mkdir(clientDirectory);
  await Promise.all([
    writeFile(join(clientDirectory, "index.html"), "<h1>secure trace notebook</h1>"),
    writeFile(certificatePath, TEST_SERVER_CERTIFICATE),
    writeFile(privateKeyPath, TEST_SERVER_KEY),
    writeFile(certificateAuthorityPath, TEST_CA),
  ]);
  const config: ServerConfig = {
    host: LOOPBACK_HOST,
    port: 0,
    codexHome: "/unused",
    clientDirectory,
    tls: {
      enabled: true,
      certificatePath,
      privateKeyPath,
      ...(requireClientCertificate ? { certificateAuthorityPath } : {}),
    },
  };
  const server = createServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const { port } = server.address() as AddressInfo;
  return `https://${LOOPBACK_HOST}:${port}`;
}

describe("secure HTTP foundation", () => {
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

  it("serves HTTPS and does not accept plaintext HTTP on the TLS port", async () => {
    const base = await startSecure(false);
    expect(await secureStatus(base)).toBe(200);
    await expect(rawStatus(base.replace("https:", "http:"), {})).rejects.toThrow();
  });

  it("fails startup when TLS credentials are missing or invalid", async () => {
    const directory = await createTempDirectory("codex-reader-invalid-tls-");
    const clientDirectory = join(directory, "client");
    await mkdir(clientDirectory);
    const baseConfig = {
      host: LOOPBACK_HOST,
      port: 0,
      codexHome: "/unused",
      clientDirectory,
    };

    expect(() => createServer({
      ...baseConfig,
      tls: {
        enabled: true,
        certificatePath: join(directory, "missing-cert.pem"),
        privateKeyPath: join(directory, "missing-key.pem"),
      },
    })).toThrow();

    const certificatePath = join(directory, "invalid-cert.pem");
    const privateKeyPath = join(directory, "invalid-key.pem");
    await Promise.all([
      writeFile(certificatePath, "not a certificate"),
      writeFile(privateKeyPath, "not a private key"),
    ]);
    expect(() => createServer({
      ...baseConfig,
      tls: { enabled: true, certificatePath, privateKeyPath },
    })).toThrow();
  });

  it("requires a client certificate signed by the configured CA", async () => {
    const base = await startSecure(true);
    await expect(secureStatus(base)).rejects.toThrow();
    await expect(secureStatus(base, {
      certificate: TEST_UNTRUSTED_CLIENT_CERTIFICATE,
      key: TEST_UNTRUSTED_CLIENT_KEY,
    })).rejects.toThrow();
    expect(await secureStatus(base, {
      certificate: TEST_CLIENT_CERTIFICATE,
      key: TEST_CLIENT_KEY,
    })).toBe(200);
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
    const response = await fetch(`${base}/api/v1/unknown`);
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
      list: fail,
      getSession: fail,
      getItems: fail,
      getToolDetail: fail,
      getDirectiveDetail: fail,
      refresh: fail,
    };
    const logger = { error: vi.fn() };
    const base = await startWithRepository(repository, logger);

    const response = await fetch(`${base}/api/v1/sessions`);
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
