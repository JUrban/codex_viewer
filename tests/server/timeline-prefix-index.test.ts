import { describe, expect, it } from "vitest";
import type { NormalizedSession } from "../../src/server/domain/session-domain.js";
import { deriveTimelinePrefixIndex } from "../../src/server/repository/timeline-prefix-index.js";

describe("timeline prefix index", () => {
  it("retains old prefix tokens after append and rejects a rewritten prefix", () => {
    const original = normalized(["one", "two"]);
    const appended = normalized(["one", "two", "three"]);
    const rewritten = normalized(["changed", "two", "three"]);
    const key = Buffer.alloc(32, 7);
    const before = deriveTimelinePrefixIndex(original, key);
    const after = deriveTimelinePrefixIndex(appended, key);
    const changed = deriveTimelinePrefixIndex(rewritten, key);
    const boundary = before.boundaryAt(original.timeline, 2)!;

    expect(before.byteLength).toBe(72);
    expect(after.matches(appended.timeline, boundary, boundary.timelinePrefixRevision)).toBe(true);
    expect(changed.matches(rewritten.timeline, boundary, boundary.timelinePrefixRevision)).toBe(false);
  });

  it("requires strictly increasing positive ordinals", () => {
    const original = normalized(["one", "two"]);
    const value = {
      ...original,
      timeline: original.timeline.map((item, index) =>
        index === 1 ? { ...item, ordinal: 1 } : item),
    };
    expect(() => deriveTimelinePrefixIndex(value, Buffer.alloc(32)))
      .toThrow("Timeline ordinals must be strictly increasing");
  });
});

function normalized(markdown: string[]): NormalizedSession {
  return {
    session: {
      id: "session-id",
      sourceId: "source",
      origin: {
        sourceType: "test",
        sourceInstanceId: "test",
        agentName: "test",
        agentVersion: null,
        formatVersion: null,
      },
      title: "Session",
      preview: null,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      archived: false,
      parentId: null,
      childIds: [],
      agent: null,
      messageCount: markdown.length,
      toolCount: 0,
      warningCount: 0,
      diagnostics: [],
      itemCount: markdown.length,
    },
    timeline: markdown.map((text, index) => ({
      kind: "message" as const,
      id: `message-${index + 1}`,
      ordinal: index + 1,
      timestamp: null,
      role: "assistant" as const,
      phase: null,
      itemType: null,
      markdown: text,
    })),
    toolDetails: new Map(),
    directiveDetails: new Map(),
    interaction: null,
  };
}
