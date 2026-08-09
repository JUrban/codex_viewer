import { createCodexSessionSource } from "./adapters/codex/codex-session-source.js";
import type { SessionSource } from "./source/session-source.js";
import { DefaultSessionRepository } from "./repository/session-repository.js";

export function createSessionRepository(
  sources: readonly SessionSource[],
): DefaultSessionRepository {
  return new DefaultSessionRepository(sources);
}

export async function createCodexSessionRepository(
  codexHome: string,
): Promise<DefaultSessionRepository> {
  return createSessionRepository(
    [await createCodexSessionSource(codexHome)],
  );
}
