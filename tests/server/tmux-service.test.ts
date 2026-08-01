import { execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_INTERACTION_MESSAGE_BYTES,
  normalizeMessage,
  TmuxInteractionError,
  TmuxInteractionService,
  type TmuxCommandRunner,
} from "../../src/server/interaction/tmux-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

interface Call {
  readonly socketPath: string;
  readonly args: readonly string[];
  readonly input: string | undefined;
}

class FakeRunner implements TmuxCommandRunner {
  readonly calls: Call[] = [];
  panePid = "4100";
  serverStartTime = "1700000000";
  failure: ((call: Call) => Error | null) | null = null;

  async run(socketPath: string, args: readonly string[], input: string | undefined) {
    const call = { socketPath, args, input };
    this.calls.push(call);
    const failure = this.failure?.(call);
    if (failure) throw failure;
    return args[0] === "display-message"
      ? { stdout: `${this.serverStartTime}|%3|${this.panePid}|0\n` }
      : { stdout: "" };
  }
}

const sockets: Server[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function unixSocket(): Promise<string> {
  const directory = await createTempDirectory("codex-tmux-socket-");
  const path = join(directory, "tmux.sock");
  const server = createServer();
  sockets.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return path;
}

describe("tmux interaction transport", () => {
  it("normalizes message newlines and enforces whitespace and UTF-8 byte limits", () => {
    expect(normalizeMessage("alpha\r\nbeta\rgamma")).toBe("alpha\nbeta\ngamma");
    expect(() => normalizeMessage(" \n\t ")).toThrow("must not be blank");
    expect(Buffer.byteLength(normalizeMessage("界".repeat(21_845)), "utf8"))
      .toBeLessThanOrEqual(MAX_INTERACTION_MESSAGE_BYTES);
    expect(() => normalizeMessage("界".repeat(21_846))).toThrow("must not exceed");
  });

  it("revalidates and sends one bracketed paste followed by one Enter", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({
      ordinal: 1,
      valid: true,
      socketPath,
      paneId: "%3",
    });

    await service.sendMessage(binding, "first\r\nsecond 🌊");

    const displays = runner.calls.filter((call) => call.args[0] === "display-message");
    const loads = runner.calls.filter((call) => call.args[0] === "load-buffer");
    const pastes = runner.calls.filter((call) => call.args[0] === "paste-buffer");
    const keys = runner.calls.filter((call) => call.args[0] === "send-keys");
    expect(displays).toHaveLength(2);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.input).toBe("first\nsecond 🌊");
    expect(pastes).toHaveLength(1);
    expect(pastes[0]?.args).toEqual([
      "paste-buffer", "-p", "-d", "-b", expect.stringMatching(/^codex-viewer-/), "-t", "%3",
    ]);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.args).toEqual(["send-keys", "-t", "%3", "Enter"]);
  });

  it("fails closed on pane reuse and does not paste", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
    runner.panePid = "9999";
    await expect(service.sendEscape(binding)).rejects.toMatchObject({ code: "disconnected" });
    expect(runner.calls.some((call) => call.args[0] === "send-keys")).toBe(false);
  });

  it("fails closed after a tmux server restart", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
    runner.serverStartTime = "1700000001";
    await expect(service.sendInterrupt(binding)).rejects.toMatchObject({ code: "disconnected" });
    expect(runner.calls.filter((call) => call.args[0] === "send-keys")).toHaveLength(0);
  });

  it("serializes concurrent operations for the same pane", async () => {
    const socketPath = await unixSocket();
    let releaseLoad!: () => void;
    const loadBlocked = new Promise<void>((resolve) => { releaseLoad = resolve; });
    class BlockingRunner extends FakeRunner {
      override async run(
        candidateSocket: string,
        args: readonly string[],
        input: string | undefined,
      ) {
        const result = await super.run(candidateSocket, args, input);
        if (args[0] === "load-buffer") await loadBlocked;
        return result;
      }
    }
    const runner = new BlockingRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
    const message = service.sendMessage(binding, "hello");
    while (!runner.calls.some((call) => call.args[0] === "load-buffer")) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const escape = service.sendEscape(binding);
    expect(runner.calls.filter((call) => call.args[0] === "display-message")).toHaveLength(2);
    releaseLoad();
    await Promise.all([message, escape]);
    const commands = runner.calls.map((call) => call.args[0]);
    expect(commands).toEqual([
      "display-message",
      "display-message",
      "load-buffer",
      "paste-buffer",
      "send-keys",
      "display-message",
      "send-keys",
    ]);
  });

  it("reports timeout as unknown and never retries or sends Enter", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
    runner.failure = (call) => call.args[0] === "paste-buffer"
      ? new TmuxInteractionError("timeout", "unknown")
      : null;
    await expect(service.sendMessage(binding, "hello")).rejects.toMatchObject({ code: "timeout" });
    expect(runner.calls.filter((call) => call.args[0] === "paste-buffer")).toHaveLength(1);
    const paste = runner.calls.find((call) => call.args[0] === "paste-buffer");
    expect(runner.calls.find((call) => call.args[0] === "delete-buffer")?.args).toEqual([
      "delete-buffer", "-b", paste?.args[4],
    ]);
    expect(runner.calls.filter((call) => call.args.at(-1) === "Enter")).toHaveLength(0);
  });

  it("cleans up a temporary buffer when loading it fails", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
    const loadFailure = new TmuxInteractionError("timeout", "result unknown");
    runner.failure = (call) => call.args[0] === "load-buffer" ? loadFailure : null;

    await expect(service.sendMessage(binding, "hello")).rejects.toBe(loadFailure);
    const load = runner.calls.find((call) => call.args[0] === "load-buffer");
    expect(runner.calls.find((call) => call.args[0] === "delete-buffer")?.args).toEqual([
      "delete-buffer", "-b", load?.args[2],
    ]);
    expect(runner.calls.some((call) => call.args[0] === "paste-buffer")).toBe(false);
  });

  it("preserves a load failure when deleting its temporary buffer also fails", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
    const loadFailure = new TmuxInteractionError("command_failed", "load failed");
    runner.failure = (call) => {
      if (call.args[0] === "load-buffer") return loadFailure;
      if (call.args[0] === "delete-buffer") {
        return new TmuxInteractionError("command_failed", "buffer missing");
      }
      return null;
    };

    await expect(service.sendMessage(binding, "hello")).rejects.toBe(loadFailure);
    expect(runner.calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "display-message",
      "load-buffer",
      "delete-buffer",
    ]);
  });

  it("preserves a paste failure when deleting its temporary buffer also fails", async () => {
    const socketPath = await unixSocket();
    const runner = new FakeRunner();
    const service = new TmuxInteractionService(runner);
    const binding = await service.connect({ ordinal: 1, valid: true, socketPath, paneId: "%3" });
    const pasteFailure = new TmuxInteractionError("command_failed", "pane disappeared");
    runner.failure = (call) => {
      if (call.args[0] === "paste-buffer") return pasteFailure;
      if (call.args[0] === "delete-buffer") {
        return new TmuxInteractionError("command_failed", "buffer missing");
      }
      return null;
    };

    await expect(service.sendMessage(binding, "hello")).rejects.toBe(pasteFailure);
    expect(runner.calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "display-message",
      "load-buffer",
      "paste-buffer",
      "delete-buffer",
    ]);
  });

  it.runIf(spawnSync("tmux", ["-V"]).status === 0)(
    "validates a real tmux server and pane when tmux is available",
    async () => {
      const directory = await createTempDirectory("codex-real-tmux-");
      const socketPath = join(directory, "server.sock");
      execFileSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", "viewer-test", "sleep", "30"]);
      try {
        const paneId = execFileSync("tmux", [
          "-S", socketPath, "display-message", "-p", "-t", "viewer-test", "#{pane_id}",
        ], { encoding: "utf8" }).trim();
        const service = new TmuxInteractionService();
        const binding = await service.connect({
          ordinal: 1,
          valid: true,
          socketPath,
          paneId,
        });
        expect(binding.paneId).toBe(paneId);
        await service.sendEscape(binding);
      } finally {
        spawnSync("tmux", ["-S", socketPath, "kill-server"]);
      }
    },
  );
});
