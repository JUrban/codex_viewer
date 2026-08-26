import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { isClaudeSessionRecords } from "../claude/claude-session-normalizer.js";
import { PathPolicy } from "./path-policy.js";
import { BoundedRolloutSummaryReader } from "./rollout-summary-reader.js";

const MAX_ALLOWLIST_BYTES = 1024 * 1024;

export interface LoadedSessionAllowlist {
  readonly codex: ReadonlySet<string>;
  readonly claude: ReadonlySet<string>;
}

export async function loadSessionAllowlist(
  codexHome: string,
  allowlistPath: string,
): Promise<LoadedSessionAllowlist> {
  const configuredHome = resolve(codexHome);
  const configuredAllowlist = resolve(allowlistPath);
  let content: Buffer;
  try {
    content = await readFile(configuredAllowlist);
  } catch {
    throw new Error(`Could not read session allowlist: ${configuredAllowlist}`);
  }
  if (content.byteLength > MAX_ALLOWLIST_BYTES) {
    throw new Error("Session allowlist must not exceed 1 MiB");
  }

  const policy = await PathPolicy.create(configuredHome, "supported");
  const summaryReader = new BoundedRolloutSummaryReader();
  const codex = new Set<string>();
  const claude = new Set<string>();
  const lines = content.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const entry = line.trim();
    if (entry.length === 0 || entry.startsWith("#")) continue;
    const candidate = isAbsolute(entry)
      ? resolve(entry)
      : resolve(configuredHome, entry);
    const descriptor = await policy.register(candidate);
    if (descriptor === null) {
      throw new Error(
        `Session allowlist line ${index + 1} must name an existing supported JSONL ` +
          "file within the configured session roots",
      );
    }
    if (basename(descriptor.canonicalPath).startsWith("rollout-")) {
      codex.add(descriptor.canonicalPath);
    } else {
      const summary = await summaryReader.read(descriptor);
      if (isClaudeSessionRecords(summary.records)) {
        claude.add(descriptor.canonicalPath);
        continue;
      }
      throw new Error(
        `Session allowlist line ${index + 1} is not a recognized Codex or Claude ` +
          "Code session",
      );
    }
  }
  return { codex, claude };
}
