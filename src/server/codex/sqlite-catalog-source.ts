import { lstat, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentIdentity, Diagnostic } from "../../shared/domain.js";
import type { PathPolicy } from "../security/path-policy.js";
import { nonEmptyAgentIdentity, taskNameFromAgentPath } from "./agent-identity.js";
import type { CatalogEntry, CatalogMetadata } from "./catalog-source.js";

const KNOWN_COLUMNS = [
  "id",
  "rollout_path",
  "title",
  "cwd",
  "created_at",
  "updated_at",
  "parent_thread_id",
  "archived",
  "agent_nickname",
  "agent_role",
  "agent_path",
  "thread_source",
] as const;

export interface SqliteDiscovery {
  compatible: boolean;
  entries: CatalogEntry[];
  diagnostics: Diagnostic[];
}

export class SqliteCatalogSource {
  constructor(
    private readonly codexHome: string,
    private readonly policy: PathPolicy,
    private readonly disabled = false,
  ) {}

  async discover(): Promise<SqliteDiscovery> {
    if (this.disabled) return fallback("sqlite_disabled", "SQLite metadata discovery is disabled.");
    const databasePaths = await selectDatabases(this.codexHome);
    if (databasePaths.length === 0) return fallback("sqlite_missing", "No compatible SQLite state file was found.");

    for (const databasePath of databasePaths) {
      let database: DatabaseSync | null = null;
      try {
        database = new DatabaseSync(databasePath, { readOnly: true });
        const table = database
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'threads'")
          .get() as { name?: unknown } | undefined;
        if (table?.name !== "threads") continue;
        const schema = database.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>;
        const available = new Set(schema.map((column) => column.name).filter((name): name is string => typeof name === "string"));
        if (!available.has("rollout_path")) continue;
        const selected = KNOWN_COLUMNS.filter((column) => available.has(column));
        const rows = database.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM threads`).all() as Record<string, unknown>[];
        const entries: CatalogEntry[] = [];
        for (const row of rows) {
          if (typeof row.rollout_path !== "string") continue;
          const descriptor = await this.policy.register(row.rollout_path);
          if (descriptor === null) continue;
          entries.push({ descriptor, metadata: metadataFromRow(row) });
        }
        return { compatible: true, entries, diagnostics: [] };
      } catch {
        // Try the next lower database generation before falling back to JSONL.
      } finally {
        database?.close();
      }
    }
    return fallback("sqlite_unavailable", "SQLite metadata could not be read; JSONL discovery remains available.");
  }
}

async function selectDatabases(codexHome: string): Promise<string[]> {
  try {
    const canonicalHome = await realpath(codexHome);
    const candidates = (await readdir(codexHome))
      .map((name) => ({ name, match: /^state_(\d+)\.sqlite$/.exec(name) }))
      .filter((candidate): candidate is { name: string; match: RegExpExecArray } => candidate.match !== null)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]));
    const safe: string[] = [];
    for (const candidate of candidates) {
      const path = resolve(codexHome, candidate.name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const canonicalPath = await realpath(path);
      const child = relative(canonicalHome, canonicalPath);
      if (child === ".." || child.startsWith(`..${sep}`) || child.startsWith(sep)) continue;
      safe.push(canonicalPath);
    }
    return safe;
  } catch {
    return [];
  }
}

function metadataFromRow(row: Record<string, unknown>): CatalogMetadata {
  return {
    threadId: text(row.id),
    title: text(row.title),
    cwd: text(row.cwd),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    parentThreadId: text(row.parent_thread_id),
    archived: typeof row.archived === "number" ? row.archived !== 0 : null,
    agent: agentFromRow(row),
  };
}

function agentFromRow(row: Record<string, unknown>): AgentIdentity | null {
  const agentPath = text(row.agent_path);
  const threadSource = text(row.thread_source);
  const role = text(row.agent_role) ??
    (threadSource !== "subagent" && threadSource !== "cli" && threadSource !== "user"
      ? threadSource
      : null);
  return nonEmptyAgentIdentity({
    taskName: taskNameFromAgentPath(agentPath),
    nickname: text(row.agent_nickname),
    role,
  });
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function fallback(code: string, message: string): SqliteDiscovery {
  return {
    compatible: false,
    entries: [],
    diagnostics: [{ code, severity: "warning", message, ordinal: null }],
  };
}
