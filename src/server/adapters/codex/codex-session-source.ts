import { resolve } from "node:path";
import type {
  DomainDiagnostic,
  DomainSessionOrigin,
  NormalizedSession,
} from "../../domain/session-domain.js";
import { opaqueIdForParts } from "../../security/opaque-id.js";
import { PathPolicy, type RolloutDescriptor } from "./path-policy.js";
import type {
  SessionSource,
  SessionSourceDescriptor,
  SessionSourceSnapshot,
  SourceSessionEntry,
} from "../../source/session-source.js";
import { IdentityResolver } from "./identity-resolver.js";
import { JsonlCatalogSource } from "./jsonl-catalog-source.js";
import { DECODER_VERSION } from "./limits.js";
import { WholeFileRolloutDecoder, type RolloutDecoder } from "./rollout-decoder.js";
import { DefaultSessionNormalizer, type SessionNormalizer } from "./session-normalizer.js";

const EXPECTED_ROLLOUT_IO_ERRORS = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ESTALE",
  "EISDIR",
]);

interface FileFingerprint {
  readonly sourceRelativePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly decoderVersion: number;
}

interface CodexCacheEntry {
  readonly fingerprint: FileFingerprint;
  readonly normalized: NormalizedSession;
  readonly threadId: string | null;
  readonly parentThreadId: string | null;
  readonly origin: DomainSessionOrigin;
}

interface SourceEntries {
  readonly sessions: SourceSessionEntry[];
  readonly diagnostics: DomainDiagnostic[];
}

export class CodexSessionSource implements SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  #cache = new Map<string, CodexCacheEntry>();
  #snapshot: SessionSourceSnapshot | null = null;
  #discoverySignature: string | null = null;
  #hasUnavailableRollouts = false;

  constructor(
    private readonly codexHome: string,
    instanceKey: string,
    private readonly decoder: RolloutDecoder = new WholeFileRolloutDecoder(),
    private readonly identity = new IdentityResolver(),
    private readonly normalizer: SessionNormalizer = new DefaultSessionNormalizer(),
  ) {
    this.descriptor = {
      sourceType: "codex-jsonl",
      instanceKey,
      sourceInstanceId: opaqueIdForParts("source", instanceKey),
      displayName: "Codex",
    };
  }

  async refresh(): Promise<SessionSourceSnapshot> {
    const policy = await PathPolicy.create(this.codexHome);
    const discovery = await new JsonlCatalogSource(policy).discover();
    const discoverySignature = JSON.stringify({
      diagnostics: discovery.diagnostics,
      entries: discovery.entries.map(({ descriptor }) => fingerprintOf(descriptor)),
    });
    if (
      this.#snapshot !== null &&
      this.#discoverySignature === discoverySignature &&
      !this.#hasUnavailableRollouts
    ) {
      return this.#snapshot;
    }

    const nextCache = new Map<string, CodexCacheEntry>();
    const unavailableRollouts: string[] = [];
    const loadDiagnostics: DomainDiagnostic[] = [];
    for (const { descriptor } of discovery.entries) {
      const fingerprint = fingerprintOf(descriptor);
      const cached = this.#cache.get(descriptor.sourceRelativePath);
      if (cached !== undefined && sameFingerprint(cached.fingerprint, fingerprint)) {
        nextCache.set(descriptor.sourceRelativePath, cached);
      } else {
        const loaded = await this.#load(descriptor, fingerprint);
        if (loaded === null) {
          unavailableRollouts.push(descriptor.sourceRelativePath);
          loadDiagnostics.push(rolloutUnavailableDiagnostic());
        } else {
          nextCache.set(descriptor.sourceRelativePath, loaded);
        }
      }
    }
    this.#cache = nextCache;
    this.#discoverySignature = discoverySignature;
    this.#hasUnavailableRollouts = unavailableRollouts.length > 0;

    const entries = sourceEntries(nextCache);
    const diagnostics = [
      ...discovery.diagnostics.map((item) => ({ ...item })),
      ...loadDiagnostics,
      ...entries.diagnostics,
    ];
    const { sessions } = entries;
    const signature = JSON.stringify({
      discoverySignature,
      unavailableRollouts,
    });
    const snapshot = { signature, sessions, diagnostics };
    this.#snapshot = snapshot;
    return snapshot;
  }

  async #load(
    descriptor: RolloutDescriptor,
    fingerprint: FileFingerprint,
  ): Promise<CodexCacheEntry | null> {
    try {
      const decoded = await this.decoder.decode(descriptor);
      const metadata = this.identity.resolve(decoded);
      const origin = this.#origin(metadata.agentVersion);
      return {
        fingerprint,
        normalized: this.normalizer.normalize(decoded, metadata, origin),
        threadId: metadata.threadId,
        parentThreadId: metadata.parentThreadId,
        origin,
      };
    } catch (error) {
      if (!isExpectedRolloutIoError(error)) throw error;
      return null;
    }
  }

  #origin(agentVersion: string | null): DomainSessionOrigin {
    return {
      sourceType: this.descriptor.sourceType,
      sourceInstanceId: this.descriptor.sourceInstanceId,
      agentName: this.descriptor.displayName,
      agentVersion,
      formatVersion: null,
    };
  }
}

export async function createCodexSessionSource(
  codexHome: string,
): Promise<CodexSessionSource> {
  const configured = resolve(codexHome);
  return new CodexSessionSource(
    configured,
    `codex-jsonl\0${configured}`,
  );
}

function sourceEntries(
  cache: ReadonlyMap<string, CodexCacheEntry>,
): SourceEntries {
  const threadCounts = new Map<string, number>();
  for (const entry of cache.values()) {
    if (entry.threadId !== null) {
      threadCounts.set(entry.threadId, (threadCounts.get(entry.threadId) ?? 0) + 1);
    }
  }

  const sessions: SourceSessionEntry[] = [];
  const diagnostics: DomainDiagnostic[] = [];
  const reportedDuplicates = new Set<string>();
  for (const entry of cache.values()) {
    const { threadId } = entry;
    const duplicate = threadId !== null && (threadCounts.get(threadId) ?? 0) > 1;
    if (duplicate && !reportedDuplicates.has(threadId)) {
      reportedDuplicates.add(threadId);
      diagnostics.push({
        code: "duplicate_native_session_id",
        severity: "warning",
        message: "Multiple Codex rollouts declared the same native session ID.",
        ordinal: null,
      });
    }
    sessions.push({
      localId: sourceLocalId(
        threadId,
        entry.fingerprint.sourceRelativePath,
        duplicate,
      ),
      nativeSessionId: threadId,
      parentNativeSessionId: entry.parentThreadId,
      origin: entry.origin,
      normalized: entry.normalized,
    });
  }
  return { sessions, diagnostics };
}

function sourceLocalId(
  threadId: string | null,
  sourceRelativePath: string,
  duplicate: boolean,
): string {
  if (threadId === null) return `resource:${sourceRelativePath}`;
  if (duplicate) return `thread:${threadId}\0resource:${sourceRelativePath}`;
  return `thread:${threadId}`;
}

function rolloutUnavailableDiagnostic(): DomainDiagnostic {
  return {
    code: "rollout_unavailable",
    severity: "warning",
    message: "A registered rollout could not be read.",
    ordinal: null,
  };
}

function fingerprintOf(descriptor: RolloutDescriptor): FileFingerprint {
  return {
    sourceRelativePath: descriptor.sourceRelativePath,
    size: descriptor.size,
    mtimeMs: descriptor.mtimeMs,
    decoderVersion: DECODER_VERSION,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.sourceRelativePath === right.sourceRelativePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.decoderVersion === right.decoderVersion;
}

function isExpectedRolloutIoError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return EXPECTED_ROLLOUT_IO_ERRORS.has(
    String((error as NodeJS.ErrnoException).code),
  );
}
