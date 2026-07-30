import { createCodexSessionSource } from "../codex/codex-session-source.js";
import type { SearchBudget } from "../search/search-document.js";
import type { SessionSource } from "../source/session-source.js";
import { DefaultSessionRepository } from "./session-repository.js";

export function createSessionRepository(
  sources: readonly SessionSource[],
  searchBudget?: SearchBudget,
): DefaultSessionRepository {
  return new DefaultSessionRepository(sources, searchBudget);
}

export async function createCodexSessionRepository(
  codexHome: string,
  searchBudget?: SearchBudget,
): Promise<DefaultSessionRepository> {
  return createSessionRepository(
    [await createCodexSessionSource(codexHome)],
    searchBudget,
  );
}
