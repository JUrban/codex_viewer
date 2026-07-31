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
import {
  encodeStringTuple,
  opaqueIdForParts,
} from "../security/opaque-id.js";
import type {
  SessionSource,
  SessionSourceDescriptor,
  SessionSourceSnapshot,
  SourceSessionEntry,
} from "../source/session-source.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import {
  SessionRevisionRegistry,
  type SessionRevisionFactory,
  type VersionedSession,
} from "./session-revision-registry.js";

export const DEFAULT_CATALOG_FRESHNESS_MS = 3_000;

export interface CatalogSnapshot {
  readonly signature: string;
  readonly diagnostics: readonly DomainDiagnostic[];
  readonly sessions: ReadonlyMap<DomainSessionId, VersionedSession>;
  readonly documents: readonly SearchDocument[];
  readonly orderedIds: readonly DomainSessionId[];
  readonly warningCount: number;
}

export class CatalogSnapshotStore {
  readonly #coordinator = new RefreshCoordinator<CatalogSnapshot>();
  readonly #revisions: SessionRevisionRegistry;
  readonly #sources: readonly SessionSource[];
  #snapshot: CatalogSnapshot | null = null;
  #lastDiscoveryAt = Number.NEGATIVE_INFINITY;

  constructor(
    sources: readonly SessionSource[],
    private readonly freshnessMs = DEFAULT_CATALOG_FRESHNESS_MS,
    private readonly now: () => number = performance.now.bind(performance),
    revisionFactory?: SessionRevisionFactory,
  ) {
    assertUniqueSources(sources);
    this.#sources = [...sources];
    this.#revisions = new SessionRevisionRegistry(revisionFactory);
  }

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
    const loadedSources = await Promise.all(
      this.#sources.map(async (source) => ({
        descriptor: source.descriptor,
        snapshot: await source.refresh(),
      })),
    );
    const signature = aggregateSignature(loadedSources);
    const previous = this.#snapshot;
    if (previous?.signature === signature) return previous;

    const sourceDiagnostics = loadedSources.flatMap(({ snapshot }) =>
      snapshot.diagnostics.map((item) => ({ ...item }))
    );
    const linked = linkRelationships(loadedSources);
    const diagnostics = [...sourceDiagnostics, ...linked.diagnostics];
    const normalizedSessions = linked.sessions;
    const orderedIds = [...normalizedSessions.values()]
      .sort(compareSessions)
      .map((session) => session.session.id);
    const documents = orderedIds.map((id) =>
      buildSearchDocument(normalizedSessions.get(id)!)
    );
    const preparedRevisions = this.#revisions.prepare(normalizedSessions);
    const snapshot: CatalogSnapshot = {
      signature,
      diagnostics,
      sessions: preparedRevisions.sessions,
      documents,
      orderedIds,
      warningCount: warningCount(diagnostics, normalizedSessions),
    };
    preparedRevisions.commit();
    this.#snapshot = snapshot;
    return snapshot;
  }
}

interface LoadedSource {
  readonly descriptor: SessionSourceDescriptor;
  readonly snapshot: SessionSourceSnapshot;
}

interface PendingSession {
  readonly descriptor: SessionSourceDescriptor;
  readonly entry: SourceSessionEntry;
  readonly id: DomainSessionId;
}

type MutableLinkedSession = Omit<DomainSession, "childIds"> & {
  childIds: DomainSessionId[];
};

interface LinkedSessions {
  readonly sessions: Map<DomainSessionId, NormalizedSession>;
  readonly diagnostics: readonly DomainDiagnostic[];
}

function assertUniqueSources(sources: readonly SessionSource[]): void {
  const keys = new Set<string>();
  for (const source of sources) {
    const key = source.descriptor.instanceKey;
    if (keys.has(key)) {
      throw new Error(`Duplicate session source instance key: ${key}`);
    }
    keys.add(key);
  }
}

function aggregateSignature(sources: readonly LoadedSource[]): string {
  return JSON.stringify(
    [...sources]
      .sort((left, right) =>
        left.descriptor.instanceKey.localeCompare(
          right.descriptor.instanceKey,
        )
      )
      .map(({ descriptor, snapshot }) => ({
        source: descriptor.instanceKey,
        signature: snapshot.signature,
      })),
  );
}

function warningCount(
  diagnostics: readonly DomainDiagnostic[],
  sessions: ReadonlyMap<DomainSessionId, NormalizedSession>,
): number {
  const sourceWarnings = diagnostics.filter(
    (diagnostic) => diagnostic.severity !== "info",
  ).length;
  return sourceWarnings + [...sessions.values()].reduce(
    (count, session) => count + session.session.warningCount,
    0,
  );
}

function linkRelationships(
  sources: readonly LoadedSource[],
): LinkedSessions {
  const diagnostics: DomainDiagnostic[] = [];
  const pending: PendingSession[] = [];
  const identities = new Map<string, DomainSessionId | null>();
  for (const { descriptor, snapshot } of sources) {
    const localIds = new Set<string>();
    for (const entry of snapshot.sessions) {
      if (localIds.has(entry.localId)) {
        diagnostics.push({
          code: "duplicate_source_session_id",
          severity: "error",
          message: "A source returned duplicate stable session identities.",
          ordinal: null,
        });
        continue;
      }
      localIds.add(entry.localId);
      const id = opaqueIdForParts(descriptor.instanceKey, entry.localId);
      pending.push({ descriptor, entry, id });
      if (entry.nativeSessionId !== null) {
        const nativeKey = identityKey(
          descriptor.instanceKey,
          entry.nativeSessionId,
        );
        if (!identities.has(nativeKey)) identities.set(nativeKey, id);
        else identities.set(nativeKey, null);
      }
    }
  }

  const mutable = new Map<DomainSessionId, {
    session: MutableLinkedSession;
    normalized: NormalizedSession;
  }>();
  for (const item of pending) {
    const parentId = item.entry.parentNativeSessionId === null
      ? null
      : identities.get(
        identityKey(
          item.descriptor.instanceKey,
          item.entry.parentNativeSessionId,
        ),
      ) ?? null;
    const source = item.entry.normalized.session;
    mutable.set(item.id, {
      session: {
        ...source,
        id: item.id,
        sourceId: item.entry.nativeSessionId,
        origin: {
          ...item.entry.origin,
          sourceType: item.descriptor.sourceType,
          sourceInstanceId: item.descriptor.sourceInstanceId,
          agentName: item.descriptor.displayName,
        },
        parentId,
        childIds: [],
      },
      normalized: item.entry.normalized,
    });
  }
  for (const linked of mutable.values()) {
    if (linked.session.parentId === null) continue;
    mutable.get(linked.session.parentId)?.session.childIds.push(linked.session.id);
  }

  const sessions = new Map<DomainSessionId, NormalizedSession>();
  for (const [id, linked] of mutable) {
    sessions.set(id, {
      session: {
        ...linked.session,
        childIds: [...linked.session.childIds].sort(),
      },
      timeline: linked.normalized.timeline,
      toolDetails: linked.normalized.toolDetails,
      directiveDetails: linked.normalized.directiveDetails,
    });
  }
  return { sessions, diagnostics };
}

function identityKey(sourceKey: string, nativeId: string): string {
  return encodeStringTuple(sourceKey, nativeId);
}

function compareSessions(left: NormalizedSession, right: NormalizedSession): number {
  return (right.session.updatedAt ?? right.session.createdAt ?? "")
    .localeCompare(left.session.updatedAt ?? left.session.createdAt ?? "") ||
    left.session.title.localeCompare(right.session.title) ||
    compareCodeUnits(left.session.id, right.session.id);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
