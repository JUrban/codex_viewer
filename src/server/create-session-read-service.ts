import { createCodexSessionSource } from "./adapters/codex/codex-session-source.js";
import { loadSessionAllowlist } from "./adapters/codex/session-allowlist.js";
import { createClaudeSessionSource } from "./adapters/claude/claude-session-source.js";
import type { SessionSource } from "./source/session-source.js";
import { SessionReadService } from "./application/session-read-service.js";

export function createSessionReadService(
  sources: readonly SessionSource[],
): SessionReadService {
  return new SessionReadService(sources);
}

export async function createCodexSessionReadService(
  codexHome: string,
  sessionAllowlistPath?: string,
): Promise<SessionReadService> {
  const allowlist = sessionAllowlistPath === undefined
    ? null
    : await loadSessionAllowlist(codexHome, sessionAllowlistPath);
  return createSessionReadService(
    [
      await createCodexSessionSource(
        codexHome,
        undefined,
        "lazy",
        allowlist?.codex ?? null,
      ),
      await createClaudeSessionSource(
        codexHome,
        undefined,
        "lazy",
        allowlist?.claude ?? null,
      ),
    ],
  );
}
