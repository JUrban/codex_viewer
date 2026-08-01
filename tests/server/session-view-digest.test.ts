import { describe, expect, it } from "vitest";
import type {
  DomainSession,
  DomainTimelineRecord,
  NormalizedSession,
} from "../../src/server/domain/session-domain.js";
import {
  deriveSessionView,
  digestSessionView,
} from "../../src/server/repository/session-view-digest.js";

describe("digestSessionView", () => {
  it("is stable across lazy-detail map enumeration order", () => {
    const left = view();
    const right = view();
    right.toolDetails = new Map([...right.toolDetails].reverse());
    right.directiveDetails = new Map([...right.directiveDetails].reverse());

    expect(digestSessionView(right)).toBe(digestSessionView(left));
  });

  it("preserves published child order", () => {
    const original = view();
    const reordered = view();
    reordered.session = {
      ...reordered.session,
      childIds: [...reordered.session.childIds].reverse(),
    };

    expect(digestSessionView(reordered)).not.toBe(digestSessionView(original));
  });

  it("preserves published timeline order", () => {
    const reordered = view();
    reordered.timeline = [...reordered.timeline].reverse();

    expect(() => digestSessionView(reordered)).toThrow(
      "Timeline ordinals must be strictly increasing",
    );
  });

  it("stores exactly one 24-byte state per prefix and locates ordinal gaps", () => {
    const normalized = view();
    normalized.timeline = normalized.timeline.map((item, index) => ({
      ...item,
      ordinal: [2, 5, 9, 14, 20][index]!,
    })) as DomainTimelineRecord[];
    const { timelinePrefixIndex } = deriveSessionView(
      normalized,
      Buffer.alloc(32, 1),
    );

    expect(timelinePrefixIndex.byteLength)
      .toBe((normalized.timeline.length + 1) * 24);
    expect(timelinePrefixIndex.boundaryAt(normalized.timeline, 0)?.throughOrdinal)
      .toBe(0);
    expect(timelinePrefixIndex.boundaryAt(normalized.timeline, 8)?.throughOrdinal)
      .toBe(5);
    expect(timelinePrefixIndex.boundaryAt(normalized.timeline, 20)?.throughOrdinal)
      .toBe(20);
    expect(timelinePrefixIndex.boundaryAt(normalized.timeline, 21)).toBeNull();
  });

  it("publishes and verifies the empty timeline prefix", () => {
    const normalized = view();
    normalized.timeline = [];
    const { timelinePrefixIndex } = deriveSessionView(
      normalized,
      Buffer.alloc(32, 9),
    );
    const boundary = timelinePrefixIndex.boundaryAt([], 0)!;

    expect(timelinePrefixIndex.byteLength).toBe(24);
    expect(boundary.throughOrdinal).toBe(0);
    expect(timelinePrefixIndex.matches(
      [],
      boundary,
      boundary.timelinePrefixRevision,
    )).toBe(true);
  });

  it("keeps every existing prefix token on append and rejects changed prefixes and keys", () => {
    const original = view();
    const appended = view();
    appended.timeline = [
      ...appended.timeline,
      {
        kind: "message",
        id: "message-8",
        ordinal: 8,
        timestamp: null,
        role: "assistant",
        phase: "final",
        markdown: "appended",
      },
    ];
    const changed = view();
    changed.timeline = changed.timeline.map((item) =>
      item.ordinal === 3 && item.kind === "tool"
        ? { ...item, preview: "changed" }
        : item
    );
    const key = Buffer.alloc(32, 2);
    const before = deriveSessionView(original, key).timelinePrefixIndex;
    const after = deriveSessionView(appended, key).timelinePrefixIndex;
    const modified = deriveSessionView(changed, key).timelinePrefixIndex;
    const otherProcess = deriveSessionView(original, Buffer.alloc(32, 3))
      .timelinePrefixIndex;

    for (const throughOrdinal of [0, 1, 2, 3, 4, 5]) {
      const boundary = before.boundaryAt(original.timeline, throughOrdinal)!;
      expect(after.matches(appended.timeline, boundary, boundary.timelinePrefixRevision))
        .toBe(true);
    }
    const throughTool = before.boundaryAt(original.timeline, 3)!;
    expect(modified.matches(
      changed.timeline,
      modified.boundaryAt(changed.timeline, 3)!,
      throughTool.timelinePrefixRevision,
    )).toBe(false);
    expect(otherProcess.matches(
      original.timeline,
      otherProcess.boundaryAt(original.timeline, 3)!,
      throughTool.timelinePrefixRevision,
    )).toBe(false);
  });

  it.each([
    ["directive", 2, (value: MutableView) => {
      value.directiveDetails = new Map(value.directiveDetails);
      value.directiveDetails.set("directive-2", {
        ...value.directiveDetails.get("directive-2")!,
        text: "changed",
      });
    }],
    ["tool", 3, (value: MutableView) => {
      value.toolDetails = new Map(value.toolDetails);
      value.toolDetails.set("tool-3", {
        ...value.toolDetails.get("tool-3")!,
        output: "changed",
      });
    }],
  ] as const)("binds %s lazy detail to its timeline prefix", (_label, ordinal, mutate) => {
    const original = view();
    const changed = view();
    mutate(changed);
    const key = Buffer.alloc(32, 7);
    const before = deriveSessionView(original, key).timelinePrefixIndex;
    const after = deriveSessionView(changed, key).timelinePrefixIndex;
    const priorBoundary = before.boundaryAt(original.timeline, ordinal - 1)!;
    const detailBoundary = before.boundaryAt(original.timeline, ordinal)!;

    expect(after.matches(
      changed.timeline,
      after.boundaryAt(changed.timeline, ordinal - 1)!,
      priorBoundary.timelinePrefixRevision,
    )).toBe(true);
    expect(after.matches(
      changed.timeline,
      after.boundaryAt(changed.timeline, ordinal)!,
      detailBoundary.timelinePrefixRevision,
    )).toBe(false);
  });

  it.each([
    ["deletion", (items: readonly DomainTimelineRecord[]) =>
      items.filter((item) => item.ordinal !== 3).map((item, index) => ({
        ...item,
        ordinal: index + 1,
      }))],
    ["reorder", (items: readonly DomainTimelineRecord[]) =>
      [items[1]!, items[0]!, ...items.slice(2)].map((item, index) => ({
        ...item,
        ordinal: index + 1,
      }))],
    ["truncation", (items: readonly DomainTimelineRecord[]) => items.slice(0, 2)],
  ])("does not accept a %s as the old loaded prefix", (_label, mutate) => {
    const original = view();
    const changed = view();
    changed.timeline = mutate(changed.timeline);
    const key = Buffer.alloc(32, 4);
    const oldIndex = deriveSessionView(original, key).timelinePrefixIndex;
    const newIndex = deriveSessionView(changed, key).timelinePrefixIndex;
    const oldBoundary = oldIndex.boundaryAt(original.timeline, 5)!;
    const newBoundary = newIndex.boundaryAt(changed.timeline, 5);

    expect(
      newBoundary !== null &&
        newIndex.matches(
          changed.timeline,
          newBoundary,
          oldBoundary.timelinePrefixRevision,
        ),
    ).toBe(false);
  });

  it.each([
    ["linked session fields", (value: MutableView) => {
      value.session = { ...value.session, parentId: "different-parent" };
    }],
    ["origin fields", (value: MutableView) => {
      value.session = {
        ...value.session,
        origin: { ...value.session.origin, agentVersion: "2.0.0" },
      };
    }],
    ["agent fields", (value: MutableView) => {
      value.session = {
        ...value.session,
        agent: { ...value.session.agent!, role: "reviewer" },
      };
    }],
    ["diagnostics", (value: MutableView) => {
      value.session = {
        ...value.session,
        diagnostics: [{ ...value.session.diagnostics[0]!, message: "changed" }],
      };
    }],
    ["message payload", (value: MutableView) => {
      value.timeline = value.timeline.map((item) =>
        item.kind === "message" ? { ...item, markdown: "changed" } : item
      );
    }],
    ["directive summary", (value: MutableView) => {
      value.timeline = value.timeline.map((item) =>
        item.kind === "directive" ? { ...item, charCount: item.charCount + 1 } : item
      );
    }],
    ["tool summary", (value: MutableView) => {
      value.timeline = value.timeline.map((item) =>
        item.kind === "tool" ? { ...item, status: "failed" as const } : item
      );
    }],
    ["token counters", (value: MutableView) => {
      value.timeline = value.timeline.map((item) =>
        item.kind === "token"
          ? {
              ...item,
              tokenUsage: {
                ...item.tokenUsage,
                total: { ...item.tokenUsage.total!, outputTokens: 99 },
              },
            }
          : item
      );
    }],
    ["internal event payload", (value: MutableView) => {
      value.timeline = value.timeline.map((item) =>
        item.kind === "internal" ? { ...item, summary: "changed" } : item
      );
    }],
    ["tool lazy detail", (value: MutableView) => {
      value.toolDetails = new Map(value.toolDetails);
      value.toolDetails.set("tool-3", {
        ...value.toolDetails.get("tool-3")!,
        output: "changed",
      });
    }],
    ["directive lazy detail", (value: MutableView) => {
      value.directiveDetails = new Map(value.directiveDetails);
      value.directiveDetails.set("directive-2", {
        ...value.directiveDetails.get("directive-2")!,
        text: "changed",
      });
    }],
  ] as const)("changes when %s change", (_label, mutate) => {
    const original = view();
    const changed = view();
    mutate(changed);

    expect(digestSessionView(changed)).not.toBe(digestSessionView(original));
  });
});

type MutableView = {
  session: DomainSession;
  timeline: readonly DomainTimelineRecord[];
  toolDetails: Map<string, { input: string | null; output: string | null; truncated: boolean }>;
  directiveDetails: Map<string, { text: string; truncated: boolean }>;
};

function view(): MutableView {
  return {
    session: {
      id: "session",
      sourceId: "native",
      origin: {
        sourceType: "test",
        sourceInstanceId: "instance",
        agentName: "Agent",
        agentVersion: "1.0.0",
        formatVersion: "1",
      },
      title: "Title",
      preview: "Preview",
      cwd: "/project",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T01:00:00Z",
      archived: false,
      parentId: "parent",
      childIds: ["child-b", "child-a"],
      agent: { taskName: "task", nickname: "name", role: "worker" },
      messageCount: 1,
      toolCount: 1,
      warningCount: 1,
      diagnostics: [{
        code: "warning",
        severity: "warning",
        message: "warning",
        ordinal: 1,
      }],
      itemCount: 5,
    },
    timeline: [
      {
        kind: "message",
        id: "message-1",
        ordinal: 1,
        timestamp: null,
        role: "user",
        phase: null,
        markdown: "hello",
      },
      {
        kind: "directive",
        id: "directive-2",
        ordinal: 2,
        timestamp: null,
        summary: "directive",
        charCount: 9,
        truncated: false,
        hasDetail: true,
      },
      {
        kind: "tool",
        stage: "output",
        id: "tool-3",
        ordinal: 3,
        timestamp: null,
        callId: "call-3",
        toolName: "exec",
        status: "completed",
        preview: "preview",
        truncated: false,
        hasDetail: true,
      },
      {
        kind: "token",
        id: "token-4",
        ordinal: 4,
        timestamp: null,
        tokenUsage: {
          total: {
            totalTokens: 10,
            inputTokens: 7,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 1,
            outputTokens: 3,
            reasoningOutputTokens: 1,
          },
          last: null,
        },
      },
      {
        kind: "internal",
        id: "internal-5",
        ordinal: 5,
        timestamp: null,
        eventType: "reasoning",
        summary: "summary",
      },
    ],
    toolDetails: new Map([
      ["tool-z", { input: null, output: "z", truncated: true }],
      ["tool-3", { input: "input", output: "output", truncated: false }],
    ]),
    directiveDetails: new Map([
      ["directive-z", { text: "z", truncated: true }],
      ["directive-2", { text: "detail", truncated: false }],
    ]),
  } satisfies NormalizedSession;
}
