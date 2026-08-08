import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_PREVIEW_BYTES,
  type TmuxBinding,
  TmuxInteractionService,
} from "../../src/server/interaction/tmux-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

beforeAll(() => {
  if (spawnSync("tmux", ["-V"]).status !== 0) {
    throw new Error("tmux is required for the tmux integration test");
  }
});

describe("tmux interaction integration", () => {
  it("validates and captures a real tmux pane with bounded plain-text output", async () => {
    const directory = await createTempDirectory("codex-real-tmux-");
    const socketPath = join(directory, "server.sock");
    execFileSync("tmux", [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-x",
      "1200",
      "-y",
      "20",
      "-s",
      "viewer-test",
      "i=0; while [ \"$i\" -lt 520 ]; do printf '%01200d\\n' \"$i\"; i=$((i + 1)); done; printf '\\033[31mTAIL-世界\\033[0m\\n'; sleep 30",
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
      const preview = await waitForPreview(service, binding, "TAIL-世界");
      expect(preview.truncated).toBe(true);
      expect(Buffer.byteLength(preview.content, "utf8"))
        .toBeLessThanOrEqual(MAX_TERMINAL_PREVIEW_BYTES);
      expect(preview.content).toContain("TAIL-世界");
      expect(preview.content).not.toContain("\u001b[");
      expect(preview.content).not.toContain("�");
    } finally {
      spawnSync("tmux", ["-S", socketPath, "kill-server"]);
    }
  });
});

async function waitForPreview(
  service: TmuxInteractionService,
  binding: TmuxBinding,
  marker: string,
) {
  const deadline = Date.now() + 2_000;
  do {
    const preview = await service.captureTerminal(binding);
    if (preview.content.includes(marker)) return preview;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for terminal marker: ${marker}`);
}
