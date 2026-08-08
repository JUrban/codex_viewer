import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { TmuxInteractionService } from "../../src/server/interaction/tmux-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

beforeAll(() => {
  if (spawnSync("tmux", ["-V"]).status !== 0) {
    throw new Error("tmux is required for the tmux integration test");
  }
});

describe("tmux interaction integration", () => {
  it("validates a real tmux server and pane", async () => {
    const directory = await createTempDirectory("codex-real-tmux-");
    const socketPath = join(directory, "server.sock");
    execFileSync("tmux", [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-s",
      "viewer-test",
      "sleep",
      "30",
    ]);
    try {
      const paneId = execFileSync("tmux", [
        "-S",
        socketPath,
        "display-message",
        "-p",
        "-t",
        "viewer-test",
        "#{pane_id}",
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
  });
});
