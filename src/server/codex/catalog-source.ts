import type { Diagnostic } from "../../shared/domain.js";
import type { RolloutDescriptor } from "../security/path-policy.js";

export interface CatalogEntry {
  descriptor: RolloutDescriptor;
}

export interface CatalogDiscovery {
  entries: CatalogEntry[];
  diagnostics: Diagnostic[];
}

export interface CodexCatalogSource {
  discover(): Promise<CatalogDiscovery>;
}
