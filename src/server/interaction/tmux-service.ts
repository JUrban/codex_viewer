import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import type { InteractionBindingAttempt } from "../domain/session-domain.js";

export const MAX_INTERACTION_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface TmuxBinding {
  readonly socketPath: string;
  readonly serverStartTime: string;
  readonly paneId: string;
  readonly panePid: string;
}

export interface TmuxCommandRunner {
  run(
    socketPath: string,
    args: readonly string[],
    input: string | undefined,
    timeoutMs: number,
  ): Promise<{ readonly stdout: string }>;
}

export class TmuxInteractionError extends Error {
  constructor(
    readonly code: "disconnected" | "timeout" | "command_failed" | "invalid_message",
    message: string,
  ) {
    super(message);
    this.name = "TmuxInteractionError";
  }
}

export class TmuxInteractionService {
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    private readonly runner: TmuxCommandRunner = new SpawnTmuxCommandRunner(),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async connect(attempt: InteractionBindingAttempt): Promise<TmuxBinding> {
    if (!attempt.valid) throw disconnected();
    await validateSocket(attempt.socketPath);
    const identity = await this.#display(attempt.socketPath, attempt.paneId);
    return {
      socketPath: attempt.socketPath,
      serverStartTime: identity.serverStartTime,
      paneId: identity.paneId,
      panePid: identity.panePid,
    };
  }

  sendMessage(binding: TmuxBinding, message: string): Promise<void> {
    const normalized = normalizeMessage(message);
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      const bufferName = `codex-viewer-${process.pid}-${randomUUID()}`;
      let bufferMayExist = true;
      try {
        await this.#run(binding, ["load-buffer", "-b", bufferName, "-"], normalized);
        await this.#run(binding, [
          "paste-buffer", "-p", "-d", "-b", bufferName, "-t", binding.paneId,
        ]);
        bufferMayExist = false;
        await this.#run(binding, ["send-keys", "-t", binding.paneId, "Enter"]);
      } finally {
        if (bufferMayExist) {
          try {
            await this.#run(binding, ["delete-buffer", "-b", bufferName]);
          } catch {
            // Preserve the original failure; the buffer may not exist or may already be deleted.
          }
        }
      }
    });
  }

  sendInterrupt(binding: TmuxBinding): Promise<void> {
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      await this.#run(binding, ["send-keys", "-t", binding.paneId, "C-c"]);
    });
  }

  sendEscape(binding: TmuxBinding): Promise<void> {
    return this.#serialize(binding, async () => {
      await this.#revalidate(binding);
      await this.#run(binding, ["send-keys", "-t", binding.paneId, "Escape"]);
    });
  }

  async #revalidate(binding: TmuxBinding): Promise<void> {
    await validateSocket(binding.socketPath);
    const current = await this.#display(binding.socketPath, binding.paneId);
    if (
      current.serverStartTime !== binding.serverStartTime ||
      current.paneId !== binding.paneId ||
      current.panePid !== binding.panePid
    ) {
      throw disconnected();
    }
  }

  async #display(socketPath: string, paneId: string) {
    let result: { readonly stdout: string };
    try {
      result = await this.runner.run(
        socketPath,
        [
          "display-message", "-p", "-t", paneId,
          "#{start_time}|#{pane_id}|#{pane_pid}|#{pane_dead}",
        ],
        undefined,
        this.timeoutMs,
      );
    } catch (error) {
      if (error instanceof TmuxInteractionError && error.code === "timeout") throw error;
      throw disconnected();
    }
    const [serverStartTime, actualPaneId, panePid, paneDead, ...extra] =
      result.stdout.trimEnd().split("|");
    if (
      extra.length > 0 ||
      !/^\d+$/.test(serverStartTime ?? "") ||
      !/^%\d+$/.test(actualPaneId ?? "") ||
      !/^\d+$/.test(panePid ?? "") ||
      paneDead !== "0" ||
      actualPaneId !== paneId
    ) {
      throw disconnected();
    }
    return { serverStartTime: serverStartTime!, paneId: actualPaneId!, panePid: panePid! };
  }

  async #run(
    binding: TmuxBinding,
    args: readonly string[],
    input?: string,
  ): Promise<void> {
    await this.runner.run(binding.socketPath, args, input, this.timeoutMs);
  }

  #serialize(binding: TmuxBinding, operation: () => Promise<void>): Promise<void> {
    const key = `${binding.socketPath}\0${binding.paneId}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.#queues.set(key, settled);
    void settled.finally(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return current;
  }
}

export function normalizeMessage(message: string): string {
  const normalized = message.replace(/\r\n?/g, "\n");
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (normalized.trim().length === 0) {
    throw new TmuxInteractionError("invalid_message", "message must not be blank");
  }
  if (bytes > MAX_INTERACTION_MESSAGE_BYTES) {
    throw new TmuxInteractionError(
      "invalid_message",
      `message must not exceed ${MAX_INTERACTION_MESSAGE_BYTES} UTF-8 bytes`,
    );
  }
  return normalized;
}

async function validateSocket(socketPath: string): Promise<void> {
  try {
    const info = await lstat(socketPath);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!info.isSocket() || currentUid === null || info.uid !== currentUid) throw disconnected();
  } catch (error) {
    if (error instanceof TmuxInteractionError) throw error;
    throw disconnected();
  }
}

function disconnected(): TmuxInteractionError {
  return new TmuxInteractionError("disconnected", "tmux target is not connected");
}

export class SpawnTmuxCommandRunner implements TmuxCommandRunner {
  run(
    socketPath: string,
    args: readonly string[],
    input: string | undefined,
    timeoutMs: number,
  ): Promise<{ readonly stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("tmux", ["-S", socketPath, ...args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new TmuxInteractionError(
          "timeout",
          "tmux operation timed out; the result is unknown",
        )));
      }, timeoutMs);
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) target.push(chunk);
        else child.kill("SIGKILL");
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", (error) => finish(() => reject(
        new TmuxInteractionError("command_failed", error.message),
      )));
      child.stdin.once("error", (error) => finish(() => reject(
        new TmuxInteractionError("command_failed", error.message),
      )));
      child.once("close", (code) => finish(() => {
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES || code !== 0) {
          reject(new TmuxInteractionError(
            "command_failed",
            Buffer.concat(stderr).toString("utf8").trim() || "tmux command failed",
          ));
          return;
        }
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
      }));
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input, "utf8");
    });
  }
}
