import { resolve } from "node:path";
import type {
  DomainDiagnostic,
  DomainSessionOrigin,
  NormalizedSession,
} from "../../domain/session-domain.js";
import { opaqueIdForParts } from "../../security/opaque-id.js";
import type {
  SessionSource,
  SessionSourceDescriptor,
  SessionSourceSnapshot,
  SourceSessionEntry,
} from "../../source/session-source.js";
import { JsonlCatalogSource } from "../codex/jsonl-catalog-source.js";
import { DECODER_VERSION } from "../codex/limits.js";
import { PathPolicy, type RolloutDescriptor } from "../codex/path-policy.js";
import {
  CheckpointedRolloutDecoder,
  type RolloutCheckpoint,
  type RolloutDecoder,
} from "../codex/rollout-decoder.js";
import {
  BoundedRolloutSummaryReader,
  type RolloutSummaryReader,
} from "../codex/rollout-summary-reader.js";
import { loadSessionAllowlist } from "../codex/session-allowlist.js";
import {
  ClaudeSessionNormalizer,
  type ClaudeSessionNormalizerState,
} from "./claude-session-normalizer.js";

const CLAUDE_NORMALIZER_VERSION = 1;
const EXPECTED_JSONL_IO_ERRORS = new Set([
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
  readonly normalizerVersion: number;
}

interface PublishedClaudeEntry {
  readonly fingerprint: FileFingerprint;
  readonly normalized: NormalizedSession;
  readonly nativeSessionId: string | null;
  readonly origin: DomainSessionOrigin;
  readonly hydrated: boolean;
}

interface ClaudeCacheEntry extends PublishedClaudeEntry {
  readonly hydrated: true;
  readonly checkpoint: RolloutCheckpoint;
  readonly normalizerState: ClaudeSessionNormalizerState;
}

interface ClaudeSummaryCacheEntry extends PublishedClaudeEntry {
  readonly hydrated: false;
}

type LoadResult<T> = T | "unsupported" | null;
export type ClaudeCatalogMode = "eager" | "lazy";

export class ClaudeSessionSource implements SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  #cache = new Map<string, ClaudeCacheEntry>();
  #summaryCache = new Map<string, ClaudeSummaryCacheEntry>();
  #hydratedPaths = new Set<string>();
  #localPaths = new Map<string, string>();
  #snapshot: SessionSourceSnapshot | null = null;
  #discoverySignature: string | null = null;
  #hasUnavailableFiles = false;

  constructor(
    private readonly sessionHome: string,
    instanceKey: string,
    private readonly allowedCanonicalPaths: ReadonlySet<string> | null = null,
    private readonly catalogMode: ClaudeCatalogMode = "eager",
    private readonly decoder: RolloutDecoder = new CheckpointedRolloutDecoder(),
    private readonly normalizer = new ClaudeSessionNormalizer(),
    private readonly summaryReader: RolloutSummaryReader = new BoundedRolloutSummaryReader(),
  ) {
    this.descriptor = {
      sourceType: "claude-code-jsonl",
      instanceKey,
      sourceInstanceId: opaqueIdForParts("source", instanceKey),
      displayName: "Claude Code",
    };
  }

  async hydrate(localId: string): Promise<boolean> {
    if (this.catalogMode === "eager") return false;
    const sourceRelativePath = this.#localPaths.get(localId);
    if (sourceRelativePath === undefined || this.#hydratedPaths.has(sourceRelativePath)) {
      return false;
    }
    this.#hydratedPaths.add(sourceRelativePath);
    return true;
  }

  async refresh(): Promise<SessionSourceSnapshot> {
    const policy = await PathPolicy.create(
      this.sessionHome,
      this.allowedCanonicalPaths === null ? "claude" : "supported",
    );
    const discovery = await new JsonlCatalogSource(
      policy,
      this.allowedCanonicalPaths,
    ).discover();
    const discoverySignature = JSON.stringify({
      diagnostics: discovery.diagnostics,
      entries: discovery.entries.map(({ descriptor }) => ({
        ...fingerprintOf(descriptor),
        hydrated: this.catalogMode === "eager" ||
          this.#hydratedPaths.has(descriptor.sourceRelativePath),
      })),
    });
    if (
      this.#snapshot !== null &&
      this.#discoverySignature === discoverySignature &&
      !this.#hasUnavailableFiles
    ) return this.#snapshot;

    const nextCache = new Map<string, ClaudeCacheEntry>();
    const nextSummaryCache = new Map<string, ClaudeSummaryCacheEntry>();
    const published = new Map<string, PublishedClaudeEntry>();
    const diagnostics: DomainDiagnostic[] = discovery.diagnostics.map((item) => ({ ...item }));
    const unavailable: string[] = [];

    for (const { descriptor } of discovery.entries) {
      const fingerprint = fingerprintOf(descriptor);
      const path = descriptor.sourceRelativePath;
      const hydrate = this.catalogMode === "eager" || this.#hydratedPaths.has(path);
      const loaded = hydrate
        ? await this.#load(descriptor, fingerprint, this.#cache.get(path))
        : await this.#loadSummary(descriptor, fingerprint, this.#summaryCache.get(path));
      if (loaded === null) {
        unavailable.push(path);
        diagnostics.push(unavailableDiagnostic());
      } else if (loaded !== "unsupported") {
        published.set(path, loaded);
        if (loaded.hydrated) nextCache.set(path, loaded);
        else nextSummaryCache.set(path, loaded);
      }
    }

    const sessions: SourceSessionEntry[] = [];
    const localPaths = new Map<string, string>();
    for (const entry of published.values()) {
      const sourceRelativePath = entry.fingerprint.sourceRelativePath;
      const localId = `resource:${sourceRelativePath}`;
      localPaths.set(localId, sourceRelativePath);
      sessions.push({
        localId,
        nativeSessionId: entry.nativeSessionId,
        parentNativeSessionId: null,
        origin: entry.origin,
        normalized: entry.normalized,
        hydrated: entry.hydrated,
      });
    }

    const snapshot = {
      signature: JSON.stringify({ discoverySignature, unavailable }),
      sessions,
      diagnostics,
    };
    this.#cache = nextCache;
    this.#summaryCache = nextSummaryCache;
    this.#localPaths = localPaths;
    this.#discoverySignature = discoverySignature;
    this.#hasUnavailableFiles = unavailable.length > 0;
    this.#snapshot = snapshot;
    return snapshot;
  }

  async #load(
    descriptor: RolloutDescriptor,
    fingerprint: FileFingerprint,
    cached: ClaudeCacheEntry | undefined,
  ): Promise<LoadResult<ClaudeCacheEntry>> {
    if (cached !== undefined && sameFingerprint(cached.fingerprint, fingerprint)) {
      return cached;
    }
    try {
      const decoded = await this.decoder.decode(descriptor, cached?.checkpoint);
      const base = decoded.mode === "append" && cached !== undefined
        ? cached.normalizerState
        : this.normalizer.create(descriptor);
      const normalizerState = this.normalizer.append(
        base,
        decoded.records,
        decoded.diagnostics,
      );
      if (!normalizerState.recognized) return "unsupported";
      const origin = this.#origin(normalizerState.agentVersion);
      const normalized = normalizerState === cached?.normalizerState &&
          sameOrigin(origin, cached.origin)
        ? cached.normalized
        : this.normalizer.materialize(normalizerState, origin);
      return {
        fingerprint,
        normalized,
        nativeSessionId: normalizerState.nativeSessionId,
        origin,
        hydrated: true,
        checkpoint: decoded.checkpoint,
        normalizerState,
      };
    } catch (error) {
      if (!isExpectedIoError(error)) throw error;
      return null;
    }
  }

  async #loadSummary(
    descriptor: RolloutDescriptor,
    fingerprint: FileFingerprint,
    cached: ClaudeSummaryCacheEntry | undefined,
  ): Promise<LoadResult<ClaudeSummaryCacheEntry>> {
    if (cached !== undefined && sameFingerprint(cached.fingerprint, fingerprint)) {
      return cached;
    }
    try {
      const summary = await this.summaryReader.read(descriptor);
      const state = this.normalizer.append(
        this.normalizer.create(descriptor),
        summary.records,
        [],
      );
      if (!state.recognized) return "unsupported";
      const origin = this.#origin(state.agentVersion);
      const partial = this.normalizer.materialize(state, origin);
      return {
        fingerprint,
        nativeSessionId: state.nativeSessionId,
        origin,
        hydrated: false,
        normalized: {
          session: {
            ...partial.session,
            updatedAt: summary.complete
              ? partial.session.updatedAt
              : new Date(descriptor.mtimeMs).toISOString(),
            itemCount: 0,
          },
          timeline: [],
          toolDetails: new Map(),
          directiveDetails: new Map(),
          interaction: null,
        },
      };
    } catch (error) {
      if (!isExpectedIoError(error)) throw error;
      return null;
    }
  }

  #origin(agentVersion: string | null): DomainSessionOrigin {
    return {
      sourceType: this.descriptor.sourceType,
      sourceInstanceId: this.descriptor.sourceInstanceId,
      agentName: this.descriptor.displayName,
      agentVersion,
      formatVersion: "claude-code-jsonl",
    };
  }
}

export async function createClaudeSessionSource(
  sessionHome: string,
  sessionAllowlistPath?: string,
  catalogMode: ClaudeCatalogMode = "eager",
  allowedCanonicalPathsOverride?: ReadonlySet<string> | null,
): Promise<ClaudeSessionSource> {
  const configured = resolve(sessionHome);
  const allowedCanonicalPaths = allowedCanonicalPathsOverride !== undefined
    ? allowedCanonicalPathsOverride
    : sessionAllowlistPath === undefined
    ? null
    : (await loadSessionAllowlist(configured, sessionAllowlistPath)).claude;
  return new ClaudeSessionSource(
    configured,
    `claude-code-jsonl\0${configured}`,
    allowedCanonicalPaths,
    catalogMode,
  );
}

function fingerprintOf(descriptor: RolloutDescriptor): FileFingerprint {
  return {
    sourceRelativePath: descriptor.sourceRelativePath,
    size: descriptor.size,
    mtimeMs: descriptor.mtimeMs,
    decoderVersion: DECODER_VERSION,
    normalizerVersion: CLAUDE_NORMALIZER_VERSION,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.sourceRelativePath === right.sourceRelativePath &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.decoderVersion === right.decoderVersion &&
    left.normalizerVersion === right.normalizerVersion;
}

function sameOrigin(left: DomainSessionOrigin, right: DomainSessionOrigin): boolean {
  return left.sourceType === right.sourceType &&
    left.sourceInstanceId === right.sourceInstanceId &&
    left.agentName === right.agentName &&
    left.agentVersion === right.agentVersion &&
    left.formatVersion === right.formatVersion;
}

function unavailableDiagnostic(): DomainDiagnostic {
  return {
    code: "claude_session_unavailable",
    severity: "warning",
    message: "A registered Claude Code session could not be read.",
    ordinal: null,
  };
}

function isExpectedIoError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return EXPECTED_JSONL_IO_ERRORS.has(String((error as NodeJS.ErrnoException).code));
}
