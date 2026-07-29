import type { CatalogDiscovery, CatalogEntry, CodexCatalogSource } from "../codex/catalog-source.js";
import type { IdentityResolver } from "../codex/identity-resolver.js";
import type { RolloutDecoder } from "../codex/rollout-decoder.js";
import type { SessionNormalizer } from "../codex/session-normalizer.js";
import { normalizeSessionTitle } from "../codex/limits.js";
import type {
  DomainDiagnostic,
  DomainSession,
  DomainSessionId,
  NormalizedSession,
} from "../domain/session-domain.js";
import {
  buildSearchDocument,
  type SearchDocument,
} from "../search/search-document.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import {
  fingerprintOf,
  metadataKey,
  sameFingerprint,
  type SessionCacheEntry,
} from "./session-cache.js";

export const DEFAULT_CATALOG_FRESHNESS_MS = 3_000;

export interface CatalogSnapshot {
  readonly generation: number;
  readonly signature: string;
  readonly mode: CatalogDiscovery["mode"];
  readonly diagnostics: readonly DomainDiagnostic[];
  readonly sessions: ReadonlyMap<DomainSessionId, NormalizedSession>;
  readonly cache: ReadonlyMap<string, SessionCacheEntry>;
  readonly documents: readonly SearchDocument[];
  readonly orderedIds: readonly DomainSessionId[];
  readonly warningCount: number;
}

export class CatalogSnapshotStore {
  readonly #coordinator = new RefreshCoordinator<CatalogSnapshot>();
  #snapshot: CatalogSnapshot | null = null;
  #lastDiscoveryAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly source: CodexCatalogSource,
    private readonly decoder: RolloutDecoder,
    private readonly identity: IdentityResolver,
    private readonly normalizer: SessionNormalizer,
    private readonly freshnessMs = DEFAULT_CATALOG_FRESHNESS_MS,
    private readonly now: () => number = performance.now.bind(performance),
  ) {}

  async current(): Promise<CatalogSnapshot> {
    const snapshot = this.#snapshot;
    if (snapshot !== null && this.now() - this.#lastDiscoveryAt < this.freshnessMs) {
      return snapshot;
    }
    return this.#coordinator.run(() => this.#discover());
  }

  async refresh(): Promise<CatalogSnapshot> {
    return this.#coordinator.run(() => this.#discover());
  }

  async #discover(): Promise<CatalogSnapshot> {
    const snapshot = await this.#rebuild();
    this.#lastDiscoveryAt = this.now();
    return snapshot;
  }

  async #rebuild(): Promise<CatalogSnapshot> {
    const discovery = await this.source.discover();
    const signature = discoverySignature(discovery);
    const previous = this.#snapshot;
    if (previous?.signature === signature) return previous;

    const cache = new Map<string, SessionCacheEntry>();
    for (const entry of discovery.entries) {
      const fingerprint = fingerprintOf(entry.descriptor);
      const old = previous?.cache.get(entry.descriptor.canonicalPath);
      const catalogMetadataKey = metadataKey(entry.metadata);
      if (
        old !== undefined &&
        sameFingerprint(old.fingerprint, fingerprint) &&
        old.metadataKey === catalogMetadataKey
      ) {
        cache.set(entry.descriptor.canonicalPath, old);
        continue;
      }
      cache.set(
        entry.descriptor.canonicalPath,
        await this.#normalizeEntry(entry, fingerprint, catalogMetadataKey),
      );
    }

    const threadIds = new Map<string, DomainSessionId>();
    for (const entry of cache.values()) {
      if (entry.threadId !== null) threadIds.set(entry.threadId, entry.normalized.session.id);
    }
    const sessions = linkRelationships(cache, threadIds);
    const documents = [...sessions.values()].map(buildSearchDocument);
    const orderedIds = [...sessions.values()]
      .sort(compareSessions)
      .map((session) => session.session.id);
    const diagnostics = discovery.diagnostics.map((item) => ({ ...item }));
    const snapshot: CatalogSnapshot = {
      generation: (previous?.generation ?? 0) + 1,
      signature,
      mode: discovery.mode,
      diagnostics,
      sessions,
      cache,
      documents,
      orderedIds,
      warningCount: warningCount(diagnostics, sessions),
    };
    this.#snapshot = snapshot;
    return snapshot;
  }

  async #normalizeEntry(
    entry: CatalogEntry,
    fingerprint: ReturnType<typeof fingerprintOf>,
    catalogMetadataKey: string,
  ): Promise<SessionCacheEntry> {
    try {
      const decoded = await this.decoder.decode(entry.descriptor);
      const metadata = this.identity.resolve(decoded, entry.metadata);
      return {
        fingerprint,
        metadataKey: catalogMetadataKey,
        normalized: this.normalizer.normalize(decoded, metadata),
        threadId: metadata.threadId,
      };
    } catch (error) {
      if (!isExpectedRolloutIoError(error)) throw error;
      return {
        fingerprint,
        metadataKey: catalogMetadataKey,
        normalized: unavailableSession(entry),
        threadId: entry.metadata?.threadId ?? null,
      };
    }
  }
}

function warningCount(
  diagnostics: readonly DomainDiagnostic[],
  sessions: ReadonlyMap<DomainSessionId, NormalizedSession>,
): number {
  const catalogWarnings = diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length;
  return catalogWarnings + [...sessions.values()].reduce(
    (count, session) => count + session.session.warningCount,
    0,
  );
}

function unavailableSession(entry: CatalogEntry): NormalizedSession {
  const metadata = entry.metadata;
  return {
    session: {
      id: entry.descriptor.id,
      sourceId: metadata?.threadId ?? null,
      title: normalizeSessionTitle(metadata?.title ?? null) ?? "Unavailable session",
      preview: null,
      cwd: metadata?.cwd ?? null,
      createdAt: metadata?.createdAt ?? null,
      updatedAt: metadata?.updatedAt ?? null,
      archived: metadata?.archived ?? entry.descriptor.archived,
      parentId: null,
      childIds: [],
      agent: metadata?.agent ?? null,
      sourceState: "unavailable",
      messageCount: 0,
      toolCount: 0,
      warningCount: 1,
      diagnostics: [{
        code: "rollout_unavailable",
        severity: "warning",
        message: "The registered rollout could not be read.",
        ordinal: null,
      }],
      itemCount: 0,
    },
    timeline: [],
    toolDetails: new Map(),
    directiveDetails: new Map(),
  };
}

function isExpectedRolloutIoError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return new Set(["ENOENT", "EACCES", "EPERM", "ESTALE", "EISDIR"]).has(
    String((error as NodeJS.ErrnoException).code),
  );
}

function discoverySignature(discovery: CatalogDiscovery): string {
  return JSON.stringify({
    mode: discovery.mode,
    diagnostics: discovery.diagnostics,
    entries: discovery.entries.map((entry) => ({
      descriptor: fingerprintOf(entry.descriptor),
      metadata: entry.metadata,
    })),
  });
}

function linkRelationships(
  cache: ReadonlyMap<string, SessionCacheEntry>,
  threadIds: ReadonlyMap<string, DomainSessionId>,
): Map<DomainSessionId, NormalizedSession> {
  type MutableLinkedSession = Omit<DomainSession, "childIds"> & { childIds: DomainSessionId[] };
  const mutable = new Map<DomainSessionId, {
    session: MutableLinkedSession;
    normalized: NormalizedSession;
  }>();
  for (const entry of cache.values()) {
    const source = entry.normalized.session;
    const linkedParent = source.parentId === null ? null : threadIds.get(source.parentId) ?? null;
    mutable.set(source.id, {
      session: { ...source, parentId: linkedParent, childIds: [] },
      normalized: entry.normalized,
    });
  }
  for (const linked of mutable.values()) {
    if (linked.session.parentId === null) continue;
    mutable.get(linked.session.parentId)?.session.childIds.push(linked.session.id);
  }
  return new Map([...mutable].map(([id, linked]) => [id, {
    session: { ...linked.session, childIds: [...linked.session.childIds] },
    timeline: linked.normalized.timeline,
    toolDetails: linked.normalized.toolDetails,
    directiveDetails: linked.normalized.directiveDetails,
  }]));
}

function compareSessions(left: NormalizedSession, right: NormalizedSession): number {
  return (right.session.updatedAt ?? right.session.createdAt ?? "")
    .localeCompare(left.session.updatedAt ?? left.session.createdAt ?? "") ||
    left.session.title.localeCompare(right.session.title);
}
