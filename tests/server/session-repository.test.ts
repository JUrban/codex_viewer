import { cp, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexCatalogSource } from "../../src/server/codex/catalog-source.js";
import { IdentityResolver } from "../../src/server/codex/identity-resolver.js";
import { WholeFileRolloutDecoder } from "../../src/server/codex/rollout-decoder.js";
import { DefaultSessionNormalizer } from "../../src/server/codex/session-normalizer.js";
import { createSessionRepository } from "../../src/server/repository/create-session-repository.js";
import {
  DefaultSessionRepository,
  RepositoryQueryError,
} from "../../src/server/repository/session-repository.js";
import { searchDocuments } from "../../src/server/search/search-document.js";

async function fixtureRepository() {
  const home = await mkdtemp(join(tmpdir(), "codex-repository-"));
  await cp(resolve("tests/fixtures/codex-home"), home, { recursive: true });
  return { home, repository: await createSessionRepository(home, true) };
}

describe("DefaultSessionRepository", () => {
  it("coalesces concurrent refreshes and retains a generation when sources are unchanged", async () => {
    let discoveries = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const source: CodexCatalogSource = {
      async discover() {
        discoveries += 1;
        await gate;
        return { mode: "unavailable", entries: [], diagnostics: [] };
      },
    };
    const repository = new DefaultSessionRepository(
      source,
      new WholeFileRolloutDecoder(),
      new IdentityResolver(),
      new DefaultSessionNormalizer(),
    );

    const status = repository.getStatus();
    const list = repository.list({});
    release();
    expect((await status).generation).toBe(1);
    expect((await list).generation).toBe(1);
    expect(discoveries).toBe(1);
    expect((await repository.getStatus()).generation).toBe(1);
    expect(discoveries).toBe(2);
  });

  it("publishes linked summaries, pages one immutable generation, and replaces it after append", async () => {
    const { home, repository } = await fixtureRepository();
    const first = await repository.list({});
    expect(first.sessions).toHaveLength(4);
    const parent = first.sessions.find((entry) => entry.session.title === "Synthetic trace")!;
    const child = first.sessions.find((entry) => entry.session.cwd === "/synthetic/child")!;
    expect(child.session.parentId).toBe(parent.session.id);
    expect(parent.session.childIds).toContain(child.session.id);

    const page = await repository.getItems(parent.session.id, { limit: 2 });
    expect(page?.hasMore).toBe(true);
    expect(page?.nextAfterOrdinal).not.toBeNull();
    await expect(repository.getItems(parent.session.id, {
      afterOrdinal: page!.nextAfterOrdinal!,
      limit: 2,
    })).rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });

    const rollout = join(
      home,
      "sessions/2026/07/28/rollout-2026-07-28T10-00-00-basic-session.jsonl",
    );
    const previous = await readFile(rollout, "utf8");
    await writeFile(
      rollout,
      `${previous}{"timestamp":"2026-07-28T10:00:10.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final","content":[{"type":"output_text","text":"Appended generation"}]}}\n`,
    );
    const second = await repository.getSession(parent.session.id);
    expect(second!.generation).toBeGreaterThan(first.generation);
    expect(second!.session.messageCount).toBe(parent.session.messageCount + 1);
    expect(first.sessions.find((entry) => entry.session.id === parent.session.id)?.session.messageCount)
      .toBe(parent.session.messageCount);
    await expect(repository.getItems(parent.session.id, {
      afterOrdinal: page!.nextAfterOrdinal!,
      generation: first.generation,
    })).rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "stale_generation" });

    const replacement = `${rollout}.replacement`;
    await writeFile(
      replacement,
      '{"timestamp":"2026-07-28T13:00:00.000Z","type":"session_meta","payload":{"id":"basic-session","title":"Replacement trace"}}\n' +
      '{"timestamp":"2026-07-28T13:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"replacement"}]}}\n',
    );
    await rename(replacement, rollout);
    const third = await repository.getSession(parent.session.id);
    expect(third!.generation).toBeGreaterThan(second!.generation);
    expect(third!.session.title).toBe("Replacement trace");
    expect(third!.session.messageCount).toBe(1);
  });

  it("searches only permitted fields and reports bounded partial results", async () => {
    const { repository } = await fixtureRepository();
    expect((await repository.list({ q: "Synthetic trace" })).sessions).toHaveLength(1);
    expect((await repository.list({ q: "/synthetic/project" })).sessions).toHaveLength(1);
    expect((await repository.list({ q: "Final synthetic answer" })).sessions).toHaveLength(1);
    for (const canary of [
      "DEVELOPER_CANARY_NEVER_RENDER",
      "REASONING_CANARY_NEVER_RENDER",
      "INTERNAL_PAYLOAD_CANARY",
      "synthetic result",
      "call-complete",
    ]) {
      expect((await repository.list({ q: canary })).sessions).toHaveLength(0);
    }

    const partial = searchDocuments(
      [{ sessionId: "one", title: "anything", cwd: "", messages: [] }],
      "anything",
      { maxScannedBytes: 0, maxResults: 1, maxExcerptChars: 20, maxDurationMs: 100 },
    );
    expect(partial.partial).toBe(true);
    expect(partial.warnings[0]?.code).toBe("search_byte_budget");

    const resultBudget = await repository.list({ q: "synthetic", limit: 1 });
    expect(resultBudget.sessions).toHaveLength(1);
  });

  it("compares time filters as instants and rejects an inverted range", async () => {
    const { repository } = await fixtureRepository();
    const equivalentOffset = await repository.list({
      from: "2026-07-28T05:00:00-05:00",
      to: "2026-07-28T13:00:00Z",
    });
    expect(equivalentOffset.sessions.some(
      (entry) => entry.session.title === "Synthetic trace",
    )).toBe(true);

    await expect(repository.list({
      from: "2026-07-29T00:00:00Z",
      to: "2026-07-28T00:00:00Z",
    })).rejects.toMatchObject<Partial<RepositoryQueryError>>({ code: "invalid_query" });
  });
});
