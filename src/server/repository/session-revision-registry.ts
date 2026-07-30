import { createHmac, randomBytes } from "node:crypto";
import type { SessionRevision } from "../../shared/domain.js";
import type {
  DomainSessionId,
  NormalizedSession,
} from "../domain/session-domain.js";
import { digestSessionView } from "./session-view-digest.js";

export interface VersionedSession {
  readonly revision: SessionRevision;
  readonly normalized: NormalizedSession;
}

interface RevisionRecord {
  readonly digest: string;
  readonly revision: SessionRevision;
}

export interface PreparedSessionRevisions {
  readonly sessions: ReadonlyMap<DomainSessionId, VersionedSession>;
  commit(): void;
}

export type SessionRevisionFactory = (sequence: bigint) => SessionRevision;

const MAX_REVISION_SEQUENCE = (1n << 64n) - 1n;

export class SessionRevisionRegistry {
  #published = new Map<DomainSessionId, RevisionRecord>();
  #nextSequence = 0n;

  constructor(
    private readonly createRevision: SessionRevisionFactory =
      createProcessRevisionFactory(),
  ) {}

  prepare(
    sessions: ReadonlyMap<DomainSessionId, NormalizedSession>,
  ): PreparedSessionRevisions {
    const next = new Map<DomainSessionId, RevisionRecord>();
    const versioned = new Map<DomainSessionId, VersionedSession>();
    for (const [id, normalized] of sessions) {
      const digest = digestSessionView(normalized);
      const previous = this.#published.get(id);
      const revision = previous?.digest === digest
        ? previous.revision
        : this.#allocate();
      next.set(id, { digest, revision });
      versioned.set(id, { revision, normalized });
    }
    let committed = false;
    return {
      sessions: versioned,
      commit: () => {
        if (committed) return;
        this.#published = next;
        committed = true;
      },
    };
  }

  #allocate(): SessionRevision {
    if (this.#nextSequence > MAX_REVISION_SEQUENCE) {
      throw new Error("Session revision sequence exhausted");
    }
    const revision = this.createRevision(this.#nextSequence);
    if (!isSessionRevision(revision)) {
      throw new Error("Session revision factory returned an invalid token");
    }
    this.#nextSequence += 1n;
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
