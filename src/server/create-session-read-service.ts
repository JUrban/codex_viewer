import { createCodexSessionSource } from "./adapters/codex/codex-session-source.js";
import type { SessionSource } from "./source/session-source.js";
import { SessionReadService } from "./application/session-read-service.js";

export function createSessionReadService(
  sources: readonly SessionSource[],
): SessionReadService {
  return new SessionReadService(sources);
}

export async function createCodexSessionReadService(
  codexHome: string,
): Promise<SessionReadService> {
  return createSessionReadService(
    [await createCodexSessionSource(codexHome)],
  );
}
