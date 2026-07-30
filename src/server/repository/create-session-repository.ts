import type { CodexCatalogSource } from "../codex/catalog-source.js";
import { IdentityResolver } from "../codex/identity-resolver.js";
import { JsonlCatalogSource } from "../codex/jsonl-catalog-source.js";
import { WholeFileRolloutDecoder } from "../codex/rollout-decoder.js";
import { DefaultSessionNormalizer } from "../codex/session-normalizer.js";
import { PathPolicy } from "../security/path-policy.js";
import type { SearchBudget } from "../search/search-document.js";
import { DefaultSessionRepository } from "./session-repository.js";

class DynamicCatalogSource implements CodexCatalogSource {
  constructor(private readonly codexHome: string) {}

  async discover() {
    const policy = await PathPolicy.create(this.codexHome);
    return new JsonlCatalogSource(policy).discover();
  }
}

export function createSessionRepository(
  codexHome: string,
  searchBudget?: SearchBudget,
): DefaultSessionRepository {
  return new DefaultSessionRepository(
    new DynamicCatalogSource(codexHome),
    new WholeFileRolloutDecoder(),
    new IdentityResolver(),
    new DefaultSessionNormalizer(),
    searchBudget,
  );
}
