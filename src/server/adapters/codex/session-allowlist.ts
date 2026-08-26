import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PathPolicy } from "./path-policy.js";

const MAX_ALLOWLIST_BYTES = 1024 * 1024;

export async function loadSessionAllowlist(
  codexHome: string,
  allowlistPath: string,
): Promise<ReadonlySet<string>> {
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

  const policy = await PathPolicy.create(configuredHome);
  const allowed = new Set<string>();
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
        `Session allowlist line ${index + 1} must name an existing rollout file ` +
          "within the configured Codex session roots",
      );
    }
    allowed.add(descriptor.canonicalPath);
  }
  return allowed;
}
