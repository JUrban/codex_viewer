import type { AgentIdentity, Diagnostic } from "../../shared/domain.js";
import type { RolloutDescriptor } from "../security/path-policy.js";
import { JsonlCatalogSource } from "./jsonl-catalog-source.js";
import { SqliteCatalogSource } from "./sqlite-catalog-source.js";

export interface CatalogMetadata {
  threadId: string | null;
  title: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  parentThreadId: string | null;
  archived: boolean | null;
  agent?: AgentIdentity | null;
}

export interface CatalogEntry {
  descriptor: RolloutDescriptor;
  metadata: CatalogMetadata | null;
}

export interface CatalogDiscovery {
  mode: "sqlite+jsonl" | "jsonl" | "unavailable";
  entries: CatalogEntry[];
  diagnostics: Diagnostic[];
}

export interface CodexCatalogSource {
  discover(): Promise<CatalogDiscovery>;
}

export class CompositeCatalogSource implements CodexCatalogSource {
  constructor(
    private readonly jsonl: JsonlCatalogSource,
    private readonly sqlite: SqliteCatalogSource | null,
  ) {}

  async discover(): Promise<CatalogDiscovery> {
    const jsonl = await this.jsonl.discover();
    if (this.sqlite === null) return jsonl;
    const sqlite = await this.sqlite.discover();
    const entriesByPath = new Map(
      jsonl.entries.map((entry) => [entry.descriptor.canonicalPath, entry]),
    );
    for (const entry of sqlite.entries) {
      const discovered = entriesByPath.get(entry.descriptor.canonicalPath);
      entriesByPath.set(entry.descriptor.canonicalPath, {
        descriptor: discovered?.descriptor ?? entry.descriptor,
        metadata: entry.metadata ?? discovered?.metadata ?? null,
      });
    }
    return {
      mode: sqlite.compatible ? "sqlite+jsonl" : jsonl.mode,
      entries: [...entriesByPath.values()].sort((left, right) =>
        left.descriptor.canonicalPath.localeCompare(right.descriptor.canonicalPath)),
      diagnostics: [...sqlite.diagnostics, ...jsonl.diagnostics],
    };
  }
}
