import { homedir } from "node:os";
import { resolve } from "node:path";

export const LOOPBACK_HOST = "127.0.0.1" as const;

export interface ServerConfig {
  host: string;
  port: number;
  codexHome: string;
  clientDirectory: string;
}

function parseHost(value: string | undefined): string {
  if (value === undefined) return LOOPBACK_HOST;
  const host = value.trim();
  if (host.length === 0) {
    throw new Error("CODEX_VIEWER_HOST must not be empty");
  }
  return host;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 4173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("CODEX_VIEWER_PORT must be an integer between 0 and 65535");
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: parseHost(env.CODEX_VIEWER_HOST),
    port: parsePort(env.CODEX_VIEWER_PORT),
    codexHome: resolve(env.CODEX_HOME ?? homedir(), env.CODEX_HOME ? "." : ".codex"),
    clientDirectory: resolve(process.cwd(), "dist/client"),
  };
}
