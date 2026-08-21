import { describe, expect, it } from "vitest";
import { OpaqueCursorCodec } from "../../src/server/repository/opaque-cursor.js";
import type { ListCursor, TimelineCursor } from "../../src/shared/api-contract.js";

describe("OpaqueCursorCodec", () => {
  it("distinguishes valid, malformed, and differently signed list cursors", () => {
    const first = new OpaqueCursorCodec(Buffer.alloc(32, 1));
    const restarted = new OpaqueCursorCodec(Buffer.alloc(32, 2));
    const cursor = first.encodeList({ limit: 10 }, 10, "revision");

    expect(first.decodeList(cursor)).toMatchObject({
      kind: "valid",
      value: { o: 10, r: "revision" },
    });
    expect(restarted.decodeList(cursor)).toEqual({ kind: "untrusted" });
    expect(first.decodeList("not-a-cursor" as ListCursor))
      .toEqual({ kind: "malformed" });
  });

  it("classifies a timeline cursor signed by another instance as untrusted", () => {
    const first = new OpaqueCursorCodec(Buffer.alloc(32, 3));
    const restarted = new OpaqueCursorCodec(Buffer.alloc(32, 4));
    const cursor = first.encodeTimeline("session-id", 7, "prefix-token");

    expect(first.decodeTimeline(cursor)).toMatchObject({
      kind: "valid",
      value: { s: "session-id", o: 7, p: "prefix-token" },
    });
    expect(restarted.decodeTimeline(cursor)).toEqual({ kind: "untrusted" });
    expect(first.decodeTimeline("e30.invalid" as TimelineCursor))
      .toEqual({ kind: "malformed" });
  });
});
