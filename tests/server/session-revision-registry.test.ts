import { describe, expect, it } from "vitest";
import type { NormalizedSession } from "../../src/server/domain/session-domain.js";
import { SessionRevisionRegistry } from "../../src/server/repository/session-revision-registry.js";
import { deriveSessionView } from "../../src/server/repository/session-view-digest.js";

describe("SessionRevisionRegistry", () => {
  it("reuses unchanged revisions and replaces changed revisions", () => {
    const registry = registryWith("a", "b");
    const first = publish(registry, sessions("A"));
    const unchanged = publish(registry, sessions("A"));
    const changed = publish(registry, sessions("B"));

    expect(revision(unchanged)).toBe(revision(first));
    expect(revision(changed)).not.toBe(revision(first));
  });

  it("does not reuse a revision after deletion, reappearance, or ABA", () => {
    const registry = registryWith("a", "b", "c", "d");
    const first = publish(registry, sessions("A"));
    publish(registry, new Map());
    const reappeared = publish(registry, sessions("A"));
    const stateB = publish(registry, sessions("B"));
    const stateAAgain = publish(registry, sessions("A"));

    expect(revision(reappeared)).not.toBe(revision(first));
    expect(revision(stateB)).not.toBe(revision(reappeared));
    expect(revision(stateAAgain)).not.toBe(revision(reappeared));
  });

  it("does not publish prepared state until commit", () => {
    const registry = registryWith("a", "b", "c");
    const first = publish(registry, sessions("A"));
    registry.prepare(sessions("B"));
    const stillComparedWithA = publish(registry, sessions("A"));

    expect(revision(stillComparedWithA)).toBe(revision(first));
  });

  it("skips digest work for clean published sessions", () => {
    const digested: string[] = [];
    const registry = new SessionRevisionRegistry(
      sequenceToken,
      (normalized, prefixKey) => {
        digested.push(normalized.session.title);
        return {
          ...deriveSessionView(normalized, prefixKey),
          viewDigest: normalized.session.title,
        };
      },
    );
    const first = publish(registry, sessions("A"));
    const prepared = registry.prepare(sessions("A"), new Set());
    prepared.commit();

    expect(digested).toEqual(["A"]);
    expect(revision(prepared.sessions)).toBe(revision(first));
  });

  it("does not consume prepared revision sequences unless committed", () => {
    const observed: bigint[] = [];
    const registry = new SessionRevisionRegistry((sequence) => {
      observed.push(sequence);
      return sequenceToken(sequence);
    });
    publish(registry, sessions("A"));
    registry.prepare(sessions("B"));
    const published = publish(registry, sessions("C"));

    expect(observed).toEqual([0n, 1n, 1n]);
    expect(revision(published)).toBe(sequenceToken(1n));
  });

  it("rejects a prepared result after another result commits", () => {
    const registry = new SessionRevisionRegistry(
      sequenceToken,
      (normalized, prefixKey) => ({
        ...deriveSessionView(normalized, prefixKey),
        viewDigest: normalized.session.title,
      }),
    );
    const first = registry.prepare(sessions("A"));
    const stale = registry.prepare(sessions("B"));

    first.commit();

    expect(() => stale.commit()).toThrow(
      "Cannot commit stale prepared session revisions",
    );
    const stillPublished = publish(registry, sessions("A"));
    expect(revision(stillPublished)).toBe(revision(first.sessions));
  });

  it("derives non-reusing revisions from a monotonic sequence", () => {
    const observed: bigint[] = [];
    const registry = new SessionRevisionRegistry((sequence) => {
      observed.push(sequence);
      return sequenceToken(sequence);
    });
    const revisions = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      revisions.add(revision(publish(registry, sessions(String(index)))));
    }

    expect(observed).toEqual(
      Array.from({ length: 10_000 }, (_, index) => BigInt(index)),
    );
    expect(revisions.size).toBe(10_000);
  });

  it("allocates opaque revisions independently across production instances", () => {
    const first = publish(new SessionRevisionRegistry(), sessions("A"));
    const otherProcess = publish(new SessionRevisionRegistry(), sessions("A"));

    expect(revision(first)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(revision(otherProcess)).not.toBe(revision(first));
  });
});

function publish(
  registry: SessionRevisionRegistry,
  values: ReadonlyMap<string, NormalizedSession>,
) {
  const prepared = registry.prepare(values);
  prepared.commit();
  return prepared.sessions;
}

function revision(values: ReturnType<typeof publish>): string {
  return values.get("session")!.revision;
}

function sessions(title: string): ReadonlyMap<string, NormalizedSession> {
  const normalized: NormalizedSession = {
    session: {
      id: "session",
      sourceId: "native",
      origin: {
        sourceType: "test",
        sourceInstanceId: "test",
        agentName: "Test",
        agentVersion: null,
        formatVersion: null,
      },
      title,
      preview: null,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      messageCount: 0,
      toolCount: 0,
      warningCount: 0,
      diagnostics: [],
      itemCount: 0,
    },
    timeline: [],
    toolDetails: new Map(),
    directiveDetails: new Map(),
  };
  return new Map([["session", normalized]]);
}

function registryWith(...values: string[]): SessionRevisionRegistry {
  return new SessionRevisionRegistry(sequenceFactory(values.map(token)));
}

function sequenceFactory(values: string[]): (sequence: bigint) => string {
  return (sequence) => values[Number(sequence)] ?? sequenceToken(sequence);
}

function token(value: string): string {
  return value.repeat(32);
}

function sequenceToken(sequence: bigint): string {
  return sequence.toString(36).padStart(32, "0");
}
