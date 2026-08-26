import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "../../../shared/domain.js";
import type { PathPolicy, RolloutDescriptor } from "./path-policy.js";
import type { CatalogDiscovery, CatalogEntry, CodexCatalogSource } from "./catalog-source.js";

export class JsonlCatalogSource implements CodexCatalogSource {
  constructor(
    private readonly policy: PathPolicy,
    private readonly allowedCanonicalPaths: ReadonlySet<string> | null = null,
  ) {}

  async discover(): Promise<CatalogDiscovery> {
    const descriptors = new Map<string, RolloutDescriptor>();
    const diagnostics: Diagnostic[] = [];
    if (this.allowedCanonicalPaths !== null) {
      for (const candidate of [...this.allowedCanonicalPaths].sort()) {
        const descriptor = await this.policy.register(candidate);
        if (descriptor === null) {
          diagnostics.push({
            code: "session_allowlist_entry_unavailable",
            severity: "warning",
            message: "An allowlisted rollout is no longer available.",
            ordinal: null,
          });
        } else {
          descriptors.set(descriptor.canonicalPath, descriptor);
        }
      }
      return discoveryFrom(descriptors, diagnostics);
    }

    for (const root of this.policy.roots()) {
      await scan(root.canonicalPath, async (candidate) => {
        const descriptor = await this.policy.register(candidate);
        if (descriptor !== null) {
          descriptors.set(descriptor.canonicalPath, descriptor);
        }
      }, diagnostics);
    }
    return discoveryFrom(descriptors, diagnostics);
  }
}

function discoveryFrom(
  descriptors: ReadonlyMap<string, RolloutDescriptor>,
  diagnostics: Diagnostic[],
): CatalogDiscovery {
  const entries: CatalogEntry[] = [...descriptors.values()]
    .sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath))
    .map((descriptor) => ({ descriptor }));
  return { entries, diagnostics };
}

async function scan(
  directory: string,
  visit: (path: string) => Promise<void>,
  diagnostics: Diagnostic[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    diagnostics.push({
      code: "session_root_unreadable",
      severity: "warning",
      message: "An allowlisted session directory could not be read.",
      ordinal: null,
    });
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path, visit, diagnostics);
    else if (entry.isFile() || entry.isSymbolicLink()) await visit(path);
  }
}
