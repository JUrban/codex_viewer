// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../../src/client/api/client";
import { useSessionInteraction } from "../../src/client/state/use-session-interaction";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("session interaction state", () => {
  it("ignores completion from the session that was active before a switch", async () => {
    const sessionA = deferred();
    const sessionB = deferred();
    vi.spyOn(api, "sendMessage").mockImplementation((sessionId) =>
      sessionId === "session-a" ? sessionA.promise : sessionB.promise);
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionInteraction(sessionId),
      { initialProps: { sessionId: "session-a" } },
    );

    let operationA!: Promise<void>;
    act(() => { operationA = result.current.sendMessage("first"); });
    const operationAResult = operationA.catch((reason: unknown) => reason);
    rerender({ sessionId: "session-b" });
    let operationB!: Promise<void>;
    act(() => { operationB = result.current.sendMessage("second"); });
    expect(result.current.busy).toBe(true);

    await act(async () => sessionA.reject(new Error("session A failed")));
    await expect(operationAResult).resolves.toMatchObject({ message: "session A failed" });
    expect(result.current.busy).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => sessionB.resolve());
    await expect(operationB).resolves.toBeUndefined();
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
