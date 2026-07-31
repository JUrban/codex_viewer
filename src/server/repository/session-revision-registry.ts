import { createHmac, randomBytes } from "node:crypto";
import type { SessionRevision } from "../../shared/domain.js";
import type {
  DomainSessionId,
  NormalizedSession,
} from "../domain/session-domain.js";
import {
  deriveSessionView,
  type DerivedSessionView,
  type TimelinePrefixIndex,
} from "./session-view-digest.js";

export interface VersionedSession {
  readonly revision: SessionRevision;
  readonly normalized: NormalizedSession;
  readonly timelinePrefixIndex: TimelinePrefixIndex;
}

interface RevisionRecord {
  readonly digest: string;
  readonly versioned: VersionedSession;
}

export interface PreparedSessionRevisions {
  readonly sessions: ReadonlyMap<DomainSessionId, VersionedSession>;
  commit(): void;
}

export type SessionRevisionFactory = (sequence: bigint) => SessionRevision;
export type SessionViewDeriver = (
  normalized: NormalizedSession,
  prefixKey: Uint8Array,
) => DerivedSessionView;

const MAX_REVISION_SEQUENCE = (1n << 64n) - 1n;

export class SessionRevisionRegistry {
  #published = new Map<DomainSessionId, RevisionRecord>();
  #nextSequence = 0n;
  #generation = 0n;

  constructor(
    private readonly createRevision: SessionRevisionFactory =
      createProcessRevisionFactory(),
    private readonly derive: SessionViewDeriver = deriveSessionView,
    private readonly prefixKey: Uint8Array = randomBytes(32),
  ) {}

  prepare(
    sessions: ReadonlyMap<DomainSessionId, NormalizedSession>,
    dirtyIds?: ReadonlySet<DomainSessionId>,
  ): PreparedSessionRevisions {
    const baseGeneration = this.#generation;
    const next = new Map<DomainSessionId, RevisionRecord>();
    const versioned = new Map<DomainSessionId, VersionedSession>();
    let nextSequence = this.#nextSequence;
    for (const [id, normalized] of sessions) {
      const previous = this.#published.get(id);
      if (
        previous !== undefined &&
        dirtyIds !== undefined &&
        !dirtyIds.has(id)
      ) {
        next.set(id, previous);
        versioned.set(id, previous.versioned);
        continue;
      }
      const derived = this.derive(normalized, this.prefixKey);
      const digest = derived.viewDigest;
      const revision = previous?.digest === digest
        ? previous.versioned.revision
        : this.#allocate(nextSequence++);
      const published = {
        revision,
        normalized,
        timelinePrefixIndex: derived.timelinePrefixIndex,
      };
      next.set(id, { digest, versioned: published });
      versioned.set(id, published);
    }
    let committed = false;
    return {
      sessions: versioned,
      commit: () => {
        if (committed) return;
        if (this.#generation !== baseGeneration) {
          throw new Error(
            "Cannot commit stale prepared session revisions",
          );
        }
        this.#published = next;
        this.#nextSequence = nextSequence;
        this.#generation += 1n;
        committed = true;
      },
    };
  }

  #allocate(sequence: bigint): SessionRevision {
    if (sequence > MAX_REVISION_SEQUENCE) {
      throw new Error("Session revision sequence exhausted");
    }
    const revision = this.createRevision(sequence);
    if (!isSessionRevision(revision)) {
      throw new Error("Session revision factory returned an invalid token");
    }
    return revision;
  }
}

function createProcessRevisionFactory(): SessionRevisionFactory {
  const processKey = randomBytes(32);
  return (sequence) => {
    const encoded = Buffer.allocUnsafe(8);
    encoded.writeBigUInt64BE(sequence);
    return createHmac("sha256", processKey)
      .update(encoded)
      .digest()
      .subarray(0, 24)
      .toString("base64url");
  };
}

export function isSessionRevision(value: string): value is SessionRevision {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}
