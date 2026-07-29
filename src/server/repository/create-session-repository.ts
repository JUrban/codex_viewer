import {
  CompositeCatalogSource,
  type CodexCatalogSource,
} from "../codex/catalog-source.js";
import { IdentityResolver } from "../codex/identity-resolver.js";
import { JsonlCatalogSource } from "../codex/jsonl-catalog-source.js";
import { WholeFileRolloutDecoder } from "../codex/rollout-decoder.js";
import { DefaultSessionNormalizer } from "../codex/session-normalizer.js";
import { SqliteCatalogSource } from "../codex/sqlite-catalog-source.js";
import { PathPolicy } from "../security/path-policy.js";
import type { SearchBudget } from "../search/search-document.js";
import { DefaultSessionRepository } from "./session-repository.js";

export async function createSessionRepository(
  codexHome: string,
  disableSqlite = false,
  searchBudget?: SearchBudget,
): Promise<DefaultSessionRepository> {
  const source: CodexCatalogSource = {
    async discover() {
      const policy = await PathPolicy.create(codexHome);
      return new CompositeCatalogSource(
        new JsonlCatalogSource(policy),
        new SqliteCatalogSource(codexHome, policy, disableSqlite),
      ).discover();
    },
  };
  return new DefaultSessionRepository(
    source,
    new WholeFileRolloutDecoder(),
    new IdentityResolver(),
    new DefaultSessionNormalizer(),
    searchBudget,
  );
}
