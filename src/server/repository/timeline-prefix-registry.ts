import { randomBytes } from "node:crypto";
import type {
  DomainSessionId,
  NormalizedSession,
} from "../domain/session-domain.js";
import {
  deriveTimelinePrefixIndex,
  type TimelinePrefixIndex,
} from "./timeline-prefix-index.js";

export interface IndexedSession {
  readonly normalized: NormalizedSession;
  readonly timelinePrefixIndex: TimelinePrefixIndex;
}

export interface PreparedTimelinePrefixes {
  readonly sessions: ReadonlyMap<DomainSessionId, IndexedSession>;
  commit(): void;
}

export type TimelinePrefixIndexBuilder = (
  normalized: NormalizedSession,
  prefixKey: Uint8Array,
) => TimelinePrefixIndex;

export class TimelinePrefixRegistry {
  #published = new Map<DomainSessionId, IndexedSession>();
  #generation = 0n;

  constructor(
    private readonly buildIndex: TimelinePrefixIndexBuilder = deriveTimelinePrefixIndex,
    private readonly prefixKey: Uint8Array = randomBytes(32),
  ) {}

  prepare(
    sessions: ReadonlyMap<DomainSessionId, NormalizedSession>,
    dirtyIds?: ReadonlySet<DomainSessionId>,
  ): PreparedTimelinePrefixes {
    const baseGeneration = this.#generation;
    const next = new Map<DomainSessionId, IndexedSession>();
    const indexed = new Map<DomainSessionId, IndexedSession>();
    for (const [id, normalized] of sessions) {
      const previous = this.#published.get(id);
      if (
        previous !== undefined &&
        dirtyIds !== undefined &&
        !dirtyIds.has(id)
      ) {
        next.set(id, previous);
        indexed.set(id, previous);
        continue;
      }
      const published = {
        normalized,
        timelinePrefixIndex: this.buildIndex(normalized, this.prefixKey),
      };
      next.set(id, published);
      indexed.set(id, published);
    }
    let committed = false;
    return {
      sessions: indexed,
      commit: () => {
        if (committed) return;
        if (this.#generation !== baseGeneration) {
          throw new Error(
            "Cannot commit stale prepared timeline prefixes",
          );
        }
        this.#published = next;
        this.#generation += 1n;
        committed = true;
      },
    };
  }

}
