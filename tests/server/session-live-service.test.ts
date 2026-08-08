import { describe, expect, it, vi } from "vitest";
import type { LiveRevision, TimelineCursor } from "../../src/shared/api-contract.js";
import type { SessionDetail } from "../../src/shared/domain.js";
import { createProcessLiveRevisionFactory } from "../../src/server/live/live-revision.js";
import { SessionLiveService } from "../../src/server/live/session-live-service.js";
import type {
  RepositoryLiveSessionSnapshot,
  SessionRepository,
} from "../../src/server/repository/session-repository.js";

const CURSOR = "opaque.timeline.cursor" as TimelineCursor;
const REVISION = "a".repeat(43) as LiveRevision;
const OTHER_REVISION = "b".repeat(43) as LiveRevision;

describe("SessionLiveService", () => {
  it("creates stable revisions that cover public session and effective interaction state", () => {
    const createRevision = createProcessLiveRevisionFactory(Buffer.alloc(32, 7));
    const first = createRevision(SESSION, { supported: false });
    expect(createRevision({ ...SESSION }, { supported: false })).toBe(first);
    expect(createRevision({ ...SESSION, title: "Changed" }, { supported: false })).not.toBe(first);
    expect(createRevision(SESSION, {
      supported: true,
      state: "connected",
      activation: "activate",
    })).not.toBe(first);
  });

  it("returns immediately for a changed revision or timeline backlog", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession);
    await expect(service.wait("session", { cursor: CURSOR, after: OTHER_REVISION }))
      .resolves.toMatchObject({ cursor: CURSOR, liveRevision: REVISION });

    getLiveSession.mockResolvedValue(snapshot(true));
    await expect(service.wait("session", { cursor: CURSOR, after: REVISION }))
      .resolves.toMatchObject({ hasMore: true });
  });

  it("repeats empty probes and returns null at the bounded timeout", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession, { probeIntervalMs: 3, waitTimeoutMs: 12 });
    await expect(service.wait("session", { cursor: CURSOR, after: REVISION }))
      .resolves.toBeNull();
    expect(getLiveSession.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("enforces the process-wide waiter limit across sessions", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession, {
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
      maxWaiters: 1,
      maxWaitersPerSession: 2,
    });
    const abort = new AbortController();
    const first = service.wait("session-one", { cursor: CURSOR, after: REVISION }, abort.signal);
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(1));
    await expect(service.wait("session-two", { cursor: CURSOR, after: REVISION }))
      .rejects.toMatchObject({ code: "live_capacity_exceeded" });
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enforces the per-session waiter limit below process capacity", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession, {
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
      maxWaiters: 2,
      maxWaitersPerSession: 1,
    });
    const abort = new AbortController();
    const first = service.wait("session", { cursor: CURSOR, after: REVISION }, abort.signal);
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(1));
    await expect(service.wait("session", { cursor: CURSOR, after: REVISION }))
      .rejects.toMatchObject({ code: "live_capacity_exceeded" });
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });

  it("releases waiters on external cancellation and service close", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false));
    const service = createService(getLiveSession, { probeIntervalMs: 1_000, waitTimeoutMs: 5_000 });
    const firstAbort = new AbortController();
    const first = service.wait("one", { cursor: CURSOR, after: REVISION }, firstAbort.signal);
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(1));
    firstAbort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const second = service.wait("two", { cursor: CURSOR, after: REVISION });
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(2));
    service.close();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
  });

  it("coalesces concurrent interaction connection probes within the short cache", async () => {
    const getLiveSession = vi.fn().mockResolvedValue(snapshot(false, true));
    let resolveDescribe!: (value: { supported: false }) => void;
    const describeSnapshot = vi.fn(() => new Promise<{ supported: false }>((resolve) => {
      resolveDescribe = resolve;
    }));
    const service = createService(getLiveSession, {
      interaction: { describeSnapshot },
      probeIntervalMs: 1_000,
      waitTimeoutMs: 5_000,
    });
    const leftAbort = new AbortController();
    const rightAbort = new AbortController();
    const left = service.wait("session", { cursor: CURSOR, after: REVISION }, leftAbort.signal);
    const right = service.wait("session", { cursor: CURSOR, after: REVISION }, rightAbort.signal);
    await vi.waitFor(() => expect(getLiveSession).toHaveBeenCalledTimes(2));
    expect(describeSnapshot).toHaveBeenCalledTimes(1);
    resolveDescribe({ supported: false });
    await Promise.resolve();
    leftAbort.abort();
    rightAbort.abort();
    await expect(left).rejects.toMatchObject({ name: "AbortError" });
    await expect(right).rejects.toMatchObject({ name: "AbortError" });
  });
});

function createService(
  getLiveSession: ReturnType<typeof vi.fn>,
  options: ConstructorParameters<typeof SessionLiveService>[1] = {},
) {
  const repository = {
    getLiveSession,
    getInteractionSession: vi.fn().mockResolvedValue(null),
  } as unknown as SessionRepository;
  return new SessionLiveService(repository, {
    createRevision: () => REVISION,
    ...options,
  });
}

function snapshot(hasMore: boolean, interaction = false): RepositoryLiveSessionSnapshot {
  return {
    session: SESSION,
    cursor: CURSOR,
    hasMore,
    interactionSession: {
      archived: false,
      interaction: interaction
        ? { activation: "activate", bindingAttempt: null }
        : null,
    },
  };
}

const SESSION: SessionDetail = {
  id: "session",
  origin: {
    sourceType: "test",
    sourceInstanceId: "test",
    agentName: "Test",
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
  messageCount: 0,
  toolCount: 0,
  warningCount: 0,
  sourceId: "session",
  diagnostics: [],
  itemCount: 0,
};
