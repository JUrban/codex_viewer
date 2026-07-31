import { describe, expect, it } from "vitest";
import type {
  DomainSessionId,
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import {
  CatalogSnapshotStore,
  type CatalogSnapshot,
} from "../../src/server/repository/catalog-snapshot-store.js";
import { deriveSessionView } from "../../src/server/repository/session-view-digest.js";
import { buildSearchDocument } from "../../src/server/search/search-document.js";
import type {
  SessionSource,
  SourceSessionEntry,
} from "../../src/server/source/session-source.js";

describe("CatalogSnapshotStore incremental derivation", () => {
  it("rebuilds digest and search state only for changed source inputs", async () => {
    const stable = normalizedSession("stable", "Stable");
    let changed = normalizedSession("changed", "Changed");
    let signature = "initial";
    let entries = [
      sourceEntry("stable", stable),
      sourceEntry("changed", changed),
    ];
    const digestCalls: string[] = [];
    const searchCalls: string[] = [];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
      {
        revisionFactory: sequenceToken,
        sessionDeriver(normalized, prefixKey) {
          digestCalls.push(normalized.session.sourceId!);
          return deriveSessionView(normalized, prefixKey);
        },
        searchDocumentBuilder(normalized) {
          searchCalls.push(normalized.session.sourceId!);
          return buildSearchDocument(normalized);
        },
      },
    );

    const first = await store.current();
    const stableId = idByTitle(first, "Stable");
    const changedId = idByTitle(first, "Changed");
    const firstStable = first.sessions.get(stableId)!;
    const firstChanged = first.sessions.get(changedId)!;
    const firstStableDocument = documentById(first, stableId);
    expect(digestCalls).toHaveLength(2);
    expect(searchCalls).toHaveLength(2);

    changed = withMessage(changed, "appended");
    entries = [
      // The source wrapper objects are deliberately recreated.
      sourceEntry("stable", stable),
      sourceEntry("changed", changed),
    ];
    signature = "append";
    const second = await store.refresh();

    expect(digestCalls).toHaveLength(3);
    expect(searchCalls).toHaveLength(3);
    expect(digestCalls.at(-1)).toBe("changed");
    expect(searchCalls.at(-1)).toBe("changed");
    expect(second.sessions.get(stableId)!.normalized)
      .toBe(firstStable.normalized);
    expect(documentById(second, stableId)).toBe(firstStableDocument);
    expect(second.sessions.get(stableId)!.revision).toBe(firstStable.revision);
    expect(second.sessions.get(changedId)!.revision)
      .not.toBe(firstChanged.revision);
  });

  it("safely recomputes a fresh normalized object but keeps its revision when the view matches", async () => {
    let normalized = normalizedSession("session", "Same");
    let signature = "first";
    const counts = { digest: 0, search: 0 };
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({
        signature,
        entries: [sourceEntry("session", normalized)],
      }))],
      0,
      () => 0,
      {
        revisionFactory: sequenceToken,
        sessionDeriver(value, prefixKey) {
          counts.digest += 1;
          return deriveSessionView(value, prefixKey);
        },
        searchDocumentBuilder(value) {
          counts.search += 1;
          return buildSearchDocument(value);
        },
      },
    );
    const first = await store.current();
    const id = idByTitle(first, "Same");

    normalized = {
      ...normalized,
      session: { ...normalized.session },
    };
    signature = "fresh-object";
    const second = await store.refresh();

    expect(counts).toEqual({ digest: 2, search: 2 });
    expect(second.sessions.get(id)!.normalized)
      .not.toBe(first.sessions.get(id)!.normalized);
    expect(second.sessions.get(id)!.revision)
      .toBe(first.sessions.get(id)!.revision);
  });

  it("updates the precise relationship dependency closure", async () => {
    const parentOne = normalizedSession("p1", "Parent one");
    const parentTwo = normalizedSession("p2", "Parent two");
    const child = normalizedSession("child", "Child");
    const lateParent = normalizedSession("late-parent", "Late parent");
    const duplicateParent = normalizedSession("duplicate", "Duplicate parent");
    let signature = "initial";
    let entries = [
      sourceEntry("p1", parentOne, "native-p1"),
      sourceEntry("p2", parentTwo, "native-p2"),
      sourceEntry("child", child, "native-child", "native-p1"),
    ];
    let searchCalls = 0;
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({ signature, entries }))],
      0,
      () => 0,
      {
        revisionFactory: sequenceToken,
        searchDocumentBuilder(normalized) {
          searchCalls += 1;
          return buildSearchDocument(normalized);
        },
      },
    );
    let snapshot = await store.current();
    const p1Id = idByTitle(snapshot, "Parent one");
    const p2Id = idByTitle(snapshot, "Parent two");
    const childId = idByTitle(snapshot, "Child");
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBe(p1Id);
    expect(snapshot.sessions.get(p1Id)!.normalized.session.childIds).toEqual([childId]);
    expect(searchCalls).toBe(3);

    const beforeReparent = revisions(snapshot);
    entries = [
      sourceEntry("p1", parentOne, "native-p1"),
      sourceEntry("p2", parentTwo, "native-p2"),
      sourceEntry("child", child, "native-child", "native-p2"),
    ];
    signature = "reparent";
    snapshot = await store.refresh();
    expect(searchCalls).toBe(6);
    expect(snapshot.sessions.get(childId)!.normalized.session.parentId).toBe(p2Id);
    expect(snapshot.sessions.get(p1Id)!.normalized.session.childIds).toEqual([]);
    expect(snapshot.sessions.get(p2Id)!.normalized.session.childIds).toEqual([childId]);
    expectChanged(snapshot, beforeReparent, [p1Id, p2Id, childId]);

    const beforeDelete = revisions(snapshot);
    entries = entries.filter((entry) => entry.localId !== "child");
    signature = "delete-child";
    snapshot = await store.refresh();
    expect(searchCalls).toBe(7);
    expect(snapshot.sessions.get(p2Id)!.normalized.session.childIds).toEqual([]);
    expectChanged(snapshot, beforeDelete, [p2Id]);
    expect(snapshot.sessions.get(p1Id)!.revision).toBe(beforeDelete.get(p1Id));

    entries = [
      ...entries,
      sourceEntry("late-child", child, "late-child", "late-native"),
    ];
    signature = "child-before-parent";
    snapshot = await store.refresh();
    const lateChildId = idByTitle(snapshot, "Child");
    expect(snapshot.sessions.get(lateChildId)!.normalized.session.parentId).toBeNull();
    expect(searchCalls).toBe(8);

    entries = [
      ...entries,
      sourceEntry("late-parent", lateParent, "late-native"),
    ];
    signature = "parent-appears";
    snapshot = await store.refresh();
    const lateParentId = idByTitle(snapshot, "Late parent");
    const firstLateParentRevision = snapshot.sessions.get(lateParentId)!.revision;
    expect(snapshot.sessions.get(lateChildId)!.normalized.session.parentId)
      .toBe(lateParentId);
    expect(snapshot.sessions.get(lateParentId)!.normalized.session.childIds)
      .toEqual([lateChildId]);
    expect(searchCalls).toBe(10);

    entries = entries.filter((entry) => entry.localId !== "late-parent");
    signature = "parent-deleted";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(lateChildId)!.normalized.session.parentId).toBeNull();
    expect(searchCalls).toBe(11);

    entries = [
      ...entries,
      sourceEntry("late-parent", lateParent, "late-native"),
    ];
    signature = "parent-reappears";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(lateParentId)!.revision)
      .not.toBe(firstLateParentRevision);
    expect(snapshot.sessions.get(lateChildId)!.normalized.session.parentId)
      .toBe(lateParentId);
    expect(searchCalls).toBe(13);

    entries = [
      ...entries,
      sourceEntry("duplicate", duplicateParent, "late-native"),
    ];
    signature = "native-duplicate";
    snapshot = await store.refresh();
    const duplicateId = idByTitle(snapshot, "Duplicate parent");
    expect(snapshot.sessions.get(lateChildId)!.normalized.session.parentId).toBeNull();
    expect(snapshot.sessions.get(lateParentId)!.normalized.session.childIds).toEqual([]);
    expect(searchCalls).toBe(16);

    const beforeRecovery = revisions(snapshot);
    entries = entries.filter((entry) => entry.localId !== "duplicate");
    signature = "native-unique-again";
    snapshot = await store.refresh();
    expect(snapshot.sessions.get(duplicateId)).toBeUndefined();
    expect(snapshot.sessions.get(lateChildId)!.normalized.session.parentId)
      .toBe(lateParentId);
    expect(snapshot.sessions.get(lateParentId)!.normalized.session.childIds)
      .toEqual([lateChildId]);
    expectChanged(snapshot, beforeRecovery, [lateChildId, lateParentId]);
    expect(searchCalls).toBe(18);
  });

  it("does not commit derived caches or revision sequence after a failed rebuild", async () => {
    let left = normalizedSession("left", "Left");
    let right = normalizedSession("right", "Right");
    let signature = "initial";
    let failSearch = false;
    let failDigest = false;
    const allocated: bigint[] = [];
    const searchCalls: string[] = [];
    const store = new CatalogSnapshotStore(
      [mutableSource(() => ({
        signature,
        entries: [
          sourceEntry("left", left),
          sourceEntry("right", right),
        ],
      }))],
      0,
      () => 0,
      {
        revisionFactory(sequence) {
          allocated.push(sequence);
          return sequenceToken(sequence);
        },
        sessionDeriver(normalized, prefixKey) {
          if (failDigest && normalized.session.sourceId === "right") {
            throw new Error("digest failed");
          }
          return deriveSessionView(normalized, prefixKey);
        },
        searchDocumentBuilder(normalized) {
          searchCalls.push(normalized.session.sourceId!);
          if (failSearch && normalized.session.sourceId === "left") {
            throw new Error("search failed");
          }
          return buildSearchDocument(normalized);
        },
      },
    );
    const initial = await store.current();
    const leftId = idByTitle(initial, "Left");
    const rightId = idByTitle(initial, "Right");

    left = withMessage(left, "left changed");
    signature = "search-failure";
    failSearch = true;
    await expect(store.refresh()).rejects.toThrow("search failed");
    failSearch = false;
    const afterSearchRecovery = await store.refresh();
    expect(searchCalls.filter((id) => id === "left")).toHaveLength(3);
    expect(afterSearchRecovery.sessions.get(rightId)!.normalized)
      .toBe(initial.sessions.get(rightId)!.normalized);

    left = withMessage(left, "left changed again");
    right = withMessage(right, "right changed");
    signature = "digest-failure";
    failDigest = true;
    await expect(store.refresh()).rejects.toThrow("digest failed");
    failDigest = false;
    const recovered = await store.refresh();

    expect(allocated).toEqual([0n, 1n, 2n, 3n, 3n, 4n]);
    expect(recovered.sessions.get(leftId)!.revision).toBe(sequenceToken(3n));
    expect(recovered.sessions.get(rightId)!.revision).toBe(sequenceToken(4n));
  });

  it("retains the published aggregate state when relationship linking fails", async () => {
    const normalized = normalizedSession("session", "Session");
    let state: "initial" | "broken" | "recovered" = "initial";
    const calls = { digest: 0, search: 0 };
    const source: SessionSource = {
      descriptor: {
        sourceType: "test",
        instanceKey: "relationship-failure",
        sourceInstanceId: "relationship-failure",
        displayName: "Test",
      },
      async refresh() {
        const entry = sourceEntry("session", normalized);
        if (state === "broken") {
          Object.defineProperty(entry, "parentNativeSessionId", {
            get() {
              throw new Error("relationship failed");
            },
          });
        }
        return {
          signature: state,
          sessions: [entry],
          diagnostics: [],
        };
      },
    };
    const store = new CatalogSnapshotStore(
      [source],
      0,
      () => 0,
      {
        revisionFactory: sequenceToken,
        sessionDeriver(value, prefixKey) {
          calls.digest += 1;
          return deriveSessionView(value, prefixKey);
        },
        searchDocumentBuilder(value) {
          calls.search += 1;
          return buildSearchDocument(value);
        },
      },
    );
    const initial = await store.current();
    const id = idByTitle(initial, "Session");
    const initialDocument = documentById(initial, id);

    state = "broken";
    await expect(store.refresh()).rejects.toThrow("relationship failed");
    state = "recovered";
    const recovered = await store.refresh();

    expect(calls).toEqual({ digest: 1, search: 1 });
    expect(recovered.sessions.get(id)!.normalized)
      .toBe(initial.sessions.get(id)!.normalized);
    expect(recovered.sessions.get(id)!.revision)
      .toBe(initial.sessions.get(id)!.revision);
    expect(documentById(recovered, id)).toBe(initialDocument);
  });
});

const TEST_ORIGIN = {
  sourceType: "test",
  sourceInstanceId: "test",
  agentName: "Test",
  agentVersion: null,
  formatVersion: null,
} as const;

function mutableSource(
  state: () => {
    signature: string;
    entries: readonly SourceSessionEntry[];
  },
): SessionSource {
  return {
    descriptor: {
      sourceType: "test",
      instanceKey: "test",
      sourceInstanceId: "test",
      displayName: "Test",
    },
    async refresh() {
      const current = state();
      return {
        signature: current.signature,
        sessions: current.entries.map((entry) => ({ ...entry })),
        diagnostics: [],
      };
    },
  };
}

function sourceEntry(
  localId: string,
  normalized: NormalizedSession,
  nativeSessionId = localId,
  parentNativeSessionId: string | null = null,
): SourceSessionEntry {
  return {
    localId,
    nativeSessionId,
    parentNativeSessionId,
    origin: TEST_ORIGIN,
    normalized,
  };
}

function normalizedSession(id: string, title: string): NormalizedSession {
  return {
    session: {
      id,
      sourceId: id,
      origin: TEST_ORIGIN,
      title,
      preview: null,
      cwd: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
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
}

function withMessage(
  normalized: NormalizedSession,
  markdown: string,
): NormalizedSession {
  const timeline: DomainTimelineRecord[] = [
    ...normalized.timeline,
    {
      kind: "message",
      id: `message-${normalized.timeline.length + 1}`,
      ordinal: normalized.timeline.length + 1,
      timestamp: null,
      role: "assistant",
      phase: "final",
      markdown,
    },
  ];
  return {
    ...normalized,
    session: {
      ...normalized.session,
      messageCount: timeline.length,
      itemCount: timeline.length,
    },
    timeline,
  };
}

function idByTitle(snapshot: CatalogSnapshot, title: string): DomainSessionId {
  const matches = [...snapshot.sessions].filter(
    ([, value]) => value.normalized.session.title === title,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one session titled ${title}, found ${matches.length}`);
  }
  return matches[0]![0];
}

function documentById(snapshot: CatalogSnapshot, id: string) {
  return snapshot.documents.find((document) => document.sessionId === id)!;
}

function revisions(snapshot: CatalogSnapshot): Map<string, string> {
  return new Map(
    [...snapshot.sessions].map(([id, value]) => [id, value.revision]),
  );
}

function expectChanged(
  snapshot: CatalogSnapshot,
  before: ReadonlyMap<string, string>,
  ids: readonly string[],
): void {
  for (const id of ids) {
    expect(snapshot.sessions.get(id)!.revision).not.toBe(before.get(id));
  }
}

function sequenceToken(sequence: bigint): string {
  return sequence.toString(36).padStart(32, "0");
}
