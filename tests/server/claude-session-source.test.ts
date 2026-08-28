import { appendFile, cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexSessionReadService } from "../../src/server/create-session-read-service.js";
import { createTempDirectory } from "../helpers/temp-directories.js";

const CLAUDE_FILE = "00000000-0000-0000-0000-000000000002.jsonl";

describe("Claude Code session source", () => {
  it("discovers, lazily hydrates, and normalizes Claude messages and tools", async () => {
    const home = await createTempDirectory("mixed-session-home-");
    const sessions = join(home, "sessions");
    await mkdir(sessions, { recursive: true });
    await cp(
      resolve("tests/fixtures/claude-code", CLAUDE_FILE),
      join(sessions, CLAUDE_FILE),
    );
    await writeFile(join(sessions, "notes.jsonl"), "{}\n");

    const repository = await createCodexSessionReadService(home);
    const listed = await repository.list({});

    expect(listed.sessions).toHaveLength(1);
    const session = listed.sessions[0]!;
    expect(session).toMatchObject({
      title: "What's in src/main.py?",
      cwd: "/home/dev/example-project",
      messageCount: 4,
      toolCount: 1,
      origin: {
        sourceType: "claude-code-jsonl",
        agentName: "Claude Code",
        agentVersion: "2.1.150",
        formatVersion: "claude-code-jsonl",
      },
    });

    const page = await repository.getItems(session.id, { limit: 20 });
    expect(page?.items).toEqual([
      expect.objectContaining({ kind: "message", role: "user", markdown: "What's in src/main.py?" }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        phase: "commentary",
        itemType: "Narration",
        markdown: "1336 of 2984 core theorems translated successfully.",
      }),
      expect.objectContaining({ kind: "message", role: "assistant", markdown: "I'll read the file." }),
      expect.objectContaining({ kind: "tool", stage: "call", toolName: "Read" }),
      expect.objectContaining({ kind: "tool", stage: "output", toolName: "Read" }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        markdown: "It prints a greeting from `main()`.",
      }),
    ]);
    expect(JSON.stringify(page?.items)).not.toContain("Private chain of thought");

    const output = page?.items.find(
      (item) => item.kind === "tool" && item.stage === "output",
    );
    expect(output).toBeDefined();
    const detail = await repository.getToolDetail(
      session.id,
      output!.id,
      { cursor: page!.cursor },
    );
    expect(detail).toMatchObject({
      input: expect.stringContaining("src/main.py"),
      output: expect.stringContaining("Hello, world!"),
      truncated: false,
    });
  });

  it("reads only newly appended Claude records after hydration", async () => {
    const home = await createTempDirectory("live-claude-home-");
    const sessions = join(home, "sessions");
    await mkdir(sessions, { recursive: true });
    const path = join(sessions, CLAUDE_FILE);
    await cp(resolve("tests/fixtures/claude-code", CLAUDE_FILE), path);
    const repository = await createCodexSessionReadService(home);
    const session = (await repository.list({})).sessions[0]!;
    expect((await repository.getItems(session.id, { limit: 20 }))?.items).toHaveLength(6);

    await appendFile(path, `${JSON.stringify({
      type: "user",
      sessionId: "00000000-0000-0000-0000-000000000002",
      uuid: "55555555-5555-5555-5555-555555552001",
      parentUuid: "44444444-4444-4444-4444-444444442001",
      isSidechain: false,
      cwd: "/home/dev/example-project",
      version: "2.1.151",
      timestamp: "2026-05-21T09:16:00.000Z",
      message: { role: "user", content: "And what does it print?" },
    })}\n`);
    await repository.refresh();

    const updated = await repository.getItems(session.id, { limit: 20 });
    expect(updated?.items).toHaveLength(7);
    expect(updated?.items.at(-1)).toMatchObject({
      kind: "message",
      role: "user",
      markdown: "And what does it print?",
    });
    expect(updated?.session.origin.agentVersion).toBe("2.1.151");
  });
});
