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
  it("sends semantic key sequences through the unified client operation", async () => {
    const sendKeys = vi.spyOn(api, "sendKeys").mockResolvedValue(undefined);
    const { result } = renderHook(() => useSessionInteraction("session-a", true));

    await act(async () => result.current.sendKeys(["interrupt", "plan", "left"]));

    expect(sendKeys).toHaveBeenCalledWith(
      "session-a",
      ["interrupt", "plan", "left"],
    );
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("ignores completion from the session that was active before a switch", async () => {
    const sessionA = deferred();
    const sessionB = deferred();
    vi.spyOn(api, "sendMessage").mockImplementation((sessionId) =>
      sessionId === "session-a" ? sessionA.promise : sessionB.promise);
    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionInteraction(sessionId, true),
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

  it("tracks terminal preview independently and clears it when disconnected", async () => {
    const captured = {
      content: "recent output",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
    };
    vi.spyOn(api, "terminalPreview").mockResolvedValue(captured);
    const { result, rerender } = renderHook(
      ({ available }) => useSessionInteraction("session-a", available),
      { initialProps: { available: true } },
    );

    await act(async () => result.current.previewTerminal());
    expect(result.current.preview).toEqual(captured);
    expect(result.current.busy).toBe(false);

    rerender({ available: false });
    expect(result.current.preview).toBeNull();
  });

  it("keeps the last successful terminal preview when a refresh fails", async () => {
    const captured = {
      content: "last successful output",
      truncated: false,
      capturedAt: "2026-08-08T12:00:00.000Z",
    };
    vi.spyOn(api, "terminalPreview")
      .mockResolvedValueOnce(captured)
      .mockRejectedValueOnce(new Error("temporary capture failure"));
    const { result } = renderHook(() => useSessionInteraction("session-a", true));

    await act(async () => result.current.previewTerminal());
    await act(async () => {
      await expect(result.current.previewTerminal()).rejects.toThrow("temporary capture failure");
    });

    expect(result.current.preview).toEqual(captured);
    expect(result.current.previewError).toBe("temporary capture failure");
    expect(result.current.previewBusy).toBe(false);
  });

  it("cancels an active terminal preview without reporting an error", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(api, "terminalPreview").mockImplementation((_sessionId, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    const { result } = renderHook(() => useSessionInteraction("session-a", true));

    let request!: Promise<void>;
    act(() => { request = result.current.previewTerminal(); });
    expect(result.current.previewBusy).toBe(true);
    act(() => result.current.cancelPreviewTerminal());

    expect(requestSignal?.aborted).toBe(true);
    expect(result.current.previewBusy).toBe(false);
    expect(result.current.previewError).toBeNull();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
