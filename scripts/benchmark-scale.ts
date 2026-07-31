import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createCodexSessionSource } from "../src/server/adapters/codex/codex-session-source.js";
import {
  DEFAULT_CATALOG_FRESHNESS_MS,
  DefaultSessionRepository,
} from "../src/server/repository/session-repository.js";
import { digestSessionView } from "../src/server/repository/session-view-digest.js";
import { buildSearchDocument } from "../src/server/search/search-document.js";

const SESSION_COUNT = 3_000;
const MIN_CORPUS_BYTES = 100 * 1024 * 1024;
const FILLER_CHARS = 18_000;
const PRIOR_SINGLE_APPEND_BASELINE_MS = 266.8;

interface Measurement {
  milliseconds: number;
  rssAfterBytes: number;
}

const root = await mkdtemp("/private/tmp/codex-viewer-scale-");
const sessions = join(root, "sessions", "2026", "07", "28");

try {
  await mkdir(sessions, { recursive: true });
  const paths = await generateCorpus(sessions);
  const totalBytes = await sumSizes(paths);
  if (totalBytes < MIN_CORPUS_BYTES) {
    throw new Error(`Synthetic corpus was only ${totalBytes} bytes`);
  }

  const derivationCalls = { digest: 0, searchDocument: 0 };
  const repository = new DefaultSessionRepository(
    [await createCodexSessionSource(root)],
    undefined,
    DEFAULT_CATALOG_FRESHNESS_MS,
    performance.now.bind(performance),
    {
      sessionDigester(normalized) {
        derivationCalls.digest += 1;
        return digestSessionView(normalized);
      },
      searchDocumentBuilder(normalized) {
        derivationCalls.searchDocument += 1;
        return buildSearchDocument(normalized);
      },
    },
  );
  const coldCatalog = await measure(() => repository.list({ limit: 200 }));
  assertDerivationDelta(
    "cold catalog",
    { digest: 0, searchDocument: 0 },
    derivationCalls,
    SESSION_COUNT,
  );
  const firstList = coldCatalog.value;
  const beforeNoChangeDerivations = { ...derivationCalls };
  const noChangeRefresh = await measure(() => repository.refresh());
  assertDerivationDelta(
    "no-change refresh",
    beforeNoChangeDerivations,
    derivationCalls,
    0,
  );
  const afterNoChangeList = await repository.list({ limit: 200 });
  if (afterNoChangeList.listRevision !== firstList.listRevision) {
    throw new Error("A no-change refresh changed listRevision");
  }
  const search = await measure(() =>
    repository.list({
      q: "needle-scale",
      project: "/synthetic/project-0",
      limit: 200,
    }));
  const absentSearch = await measure(() =>
    repository.list({ q: "absent-search-value", limit: 200 }));
  const selected = search.value.sessions[0];
  if (selected === undefined) {
    throw new Error(
      "Scale search did not find the special session: " +
        JSON.stringify({
          search: search.value,
          firstTitles: firstList.sessions.slice(0, 3).map(
            ({ session }) => session.title,
          ),
          derivationCalls,
        }),
    );
  }
  const unrelated = firstList.sessions.find((entry) => entry.session.id !== selected.session.id);
  if (unrelated === undefined) throw new Error("Scale catalog did not contain an unrelated session");
  const detailFirstPage = await measure(async () => {
    const detail = await repository.getSession(selected.session.id);
    if (detail === null) throw new Error("Scale session detail disappeared");
    const items = await repository.getItems(selected.session.id, {
      sessionRevision: detail.sessionRevision,
      limit: 50,
    });
    if (items === null) throw new Error("Scale session item page disappeared");
    return { detail, items };
  });
  const unrelatedDetail = await repository.getSession(unrelated.session.id);
  if (unrelatedDetail === null) throw new Error("Unrelated scale session detail disappeared");
  const tool = detailFirstPage.value.items.items.find((item) => item.kind === "tool");
  if (tool?.kind !== "tool") throw new Error("Large tool was not normalized");
  const toolDetail = await repository.getToolDetail(
    selected.session.id,
    tool.id,
    { sessionRevision: detailFirstPage.value.items.sessionRevision },
  );
  if (!toolDetail?.truncated) throw new Error("Large tool detail was not truncated");
  const message = detailFirstPage.value.items.items.find((item) => item.kind === "message");
  if (message?.kind !== "message" || message.markdown.length !== 1_000_000) {
    throw new Error("Long message limit was not exercised");
  }

  const specialPath = paths[0]!;
  const beforeMutationListRevision = firstList.listRevision;
  const beforeMutatedRevision = detailFirstPage.value.detail.sessionRevision;
  const unrelatedRevision = unrelatedDetail.sessionRevision;
  await appendFile(
    specialPath,
    `${JSON.stringify({
      timestamp: "2026-07-28T12:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "single-session append" }],
      },
    })}\n`,
  );
  const beforeAppendDerivations = { ...derivationCalls };
  const appendRefresh = await measure(() => repository.refresh());
  assertDerivationDelta(
    "single-session append",
    beforeAppendDerivations,
    derivationCalls,
    1,
  );
  const afterAppendList = await repository.list({ limit: 200 });
  const afterAppendDetail = await requiredDetail(repository, selected.session.id);
  const afterAppendUnrelated = await requiredDetail(repository, unrelated.session.id);
  assertMutationIsolation({
    label: "append",
    previousListRevision: beforeMutationListRevision,
    currentListRevision: afterAppendList.listRevision,
    expectListRevisionChange: false,
    previousMutatedRevision: beforeMutatedRevision,
    currentMutatedRevision: afterAppendDetail.sessionRevision,
    unrelatedRevision,
    currentUnrelatedRevision: afterAppendUnrelated.sessionRevision,
  });
  await assertOldRevisionReadable(
    repository,
    unrelated.session.id,
    unrelatedRevision,
  );

  const replacement = `${specialPath}.replacement`;
  await writeFile(replacement, `${await rollout(0, "atomic-replacement", 256)}\n`);
  await rename(replacement, specialPath);
  const beforeReplacementDerivations = { ...derivationCalls };
  const replaceRefresh = await measure(() => repository.refresh());
  assertDerivationDelta(
    "single-session replacement",
    beforeReplacementDerivations,
    derivationCalls,
    1,
  );
  const afterReplaceList = await repository.list({ limit: 200 });
  const afterReplaceDetail = await requiredDetail(repository, selected.session.id);
  const afterReplaceUnrelated = await requiredDetail(repository, unrelated.session.id);
  assertMutationIsolation({
    label: "replacement",
    previousListRevision: afterAppendList.listRevision,
    currentListRevision: afterReplaceList.listRevision,
    expectListRevisionChange: true,
    previousMutatedRevision: afterAppendDetail.sessionRevision,
    currentMutatedRevision: afterReplaceDetail.sessionRevision,
    unrelatedRevision,
    currentUnrelatedRevision: afterReplaceUnrelated.sessionRevision,
  });
  await assertOldRevisionReadable(
    repository,
    unrelated.session.id,
    unrelatedRevision,
  );

  let permissionProbe: "hidden" | "portable-skip" = "portable-skip";
  try {
    await chmod(specialPath, 0);
    await repository.refresh();
    const unavailable = await repository.getSession(selected.session.id);
    if (unavailable === null) permissionProbe = "hidden";
  } finally {
    await chmod(specialPath, 0o600);
  }

  const result = {
    corpus: {
      directory: "/private/tmp/codex-viewer-scale-<random>",
      sessionCount: SESSION_COUNT,
      bytes: totalBytes,
    },
    timingMs: {
      coldCatalog: round(coldCatalog.measurement.milliseconds),
      noChangeRefresh: round(noChangeRefresh.measurement.milliseconds),
      singleSessionAppendRefresh: round(appendRefresh.measurement.milliseconds),
      singleSessionReplaceRefresh: round(replaceRefresh.measurement.milliseconds),
      search: round(search.measurement.milliseconds),
      boundedAbsentSearch: round(absentSearch.measurement.milliseconds),
      detailFirstPage: round(detailFirstPage.measurement.milliseconds),
    },
    baselineComparison: {
      priorSingleSessionAppendMs: PRIOR_SINGLE_APPEND_BASELINE_MS,
      measuredSingleSessionAppendMs: round(
        appendRefresh.measurement.milliseconds,
      ),
      reductionPercent: round(
        100 *
          (PRIOR_SINGLE_APPEND_BASELINE_MS -
            appendRefresh.measurement.milliseconds) /
          PRIOR_SINGLE_APPEND_BASELINE_MS,
      ),
      hardTimingGate: false,
    },
    memory: {
      processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      coldCatalogRssAfterBytes: coldCatalog.measurement.rssAfterBytes,
      noChangeRefreshRssAfterBytes: noChangeRefresh.measurement.rssAfterBytes,
      appendRefreshRssAfterBytes: appendRefresh.measurement.rssAfterBytes,
      replaceRefreshRssAfterBytes: replaceRefresh.measurement.rssAfterBytes,
      searchRssAfterBytes: search.measurement.rssAfterBytes,
      detailFirstPageRssAfterBytes: detailFirstPage.measurement.rssAfterBytes,
    },
    responseBytes: {
      firstList: jsonBytes(firstList),
      search: jsonBytes(search.value),
      detail: jsonBytes(detailFirstPage.value.detail),
      firstItemPage: jsonBytes(detailFirstPage.value.items),
    },
    bounds: {
      catalogHasMore: firstList.hasMore,
      catalogTotal: firstList.total,
      searchPartial: search.value.partial,
      absentSearchPartial: absentSearch.value.partial,
      toolDetailLimitExercised: toolDetail.truncated,
      longMessageLimitExercised: message.markdown.length === 1_000_000,
      partialTailExercised: true,
      permissionProbe,
    },
    mutations: {
      listRevision: {
        unchangedAfterContentAppend:
          beforeMutationListRevision === afterAppendList.listRevision,
        changedAfterReplacementReorder:
          afterAppendList.listRevision !== afterReplaceList.listRevision,
      },
      mutatedSessionRevisionChanged: {
        afterAppend: beforeMutatedRevision !== afterAppendDetail.sessionRevision,
        afterReplace: afterAppendDetail.sessionRevision !== afterReplaceDetail.sessionRevision,
      },
      unrelatedSessionRevisionStable:
        unrelatedRevision === afterAppendUnrelated.sessionRevision &&
        unrelatedRevision === afterReplaceUnrelated.sessionRevision,
      unrelatedOldRevisionReadable: true,
    },
    derivationCalls: {
      total: derivationCalls,
      expected: {
        coldCatalog: SESSION_COUNT,
        noChangeRefresh: 0,
        singleSessionAppendRefresh: 1,
        singleSessionReplaceRefresh: 1,
      },
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function assertDerivationDelta(
  label: string,
  before: Readonly<{ digest: number; searchDocument: number }>,
  after: Readonly<{ digest: number; searchDocument: number }>,
  expected: number,
): void {
  const digest = after.digest - before.digest;
  const searchDocument = after.searchDocument - before.searchDocument;
  if (digest !== expected || searchDocument !== expected) {
    throw new Error(
      `${label} derivation calls: expected ${expected}, got ` +
        `digest=${digest}, searchDocument=${searchDocument}`,
    );
  }
}

async function generateCorpus(directory: string): Promise<string[]> {
  const paths: string[] = [];
  const filler = "scale-filler ".repeat(Math.ceil(FILLER_CHARS / 13)).slice(0, FILLER_CHARS);
  for (let start = 0; start < SESSION_COUNT; start += 50) {
    const batch = Array.from({ length: Math.min(50, SESSION_COUNT - start) }, async (_, offset) => {
      const index = start + offset;
      const id = `scale-${String(index).padStart(5, "0")}`;
      const path = join(
        directory,
        `rollout-2026-07-28T12-00-00-${id}.jsonl`,
      );
      const records = [
        rollout(index, index === 0 ? "needle-scale" : filler, index === 0 ? 1_000_000 : FILLER_CHARS),
      ];
      if (index === 0) {
        records.push(JSON.stringify({
          timestamp: "2026-07-28T12:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "large_tool",
            call_id: "large-tool",
            arguments: "I".repeat(512_000),
          },
        }));
        records.push(JSON.stringify({
          timestamp: "2026-07-28T12:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "large-tool",
            output: "O".repeat(512_000),
          },
        }));
      }
      const tail = index === 1 ? "\n{\"timestamp\":\"partial" : "\n";
      await writeFile(path, `${(await Promise.all(records)).join("\n")}${tail}`);
      paths[index] = path;
    });
    await Promise.all(batch);
  }
  return paths;
}

async function rollout(index: number, marker: string, messageChars: number): Promise<string> {
  const id = `scale-${String(index).padStart(5, "0")}`;
  const timestamp = new Date(Date.UTC(2026, 6, 28, 12, 0, index % 60)).toISOString();
  const message = `${marker} ${"m".repeat(Math.max(0, messageChars - marker.length - 1))}`;
  return [
    JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: {
        id,
        cwd: `/synthetic/project-${index % 40}`,
        title: `Synthetic scale session ${String(index).padStart(5, "0")}`,
        timestamp,
      },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: {
        type: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        phase: index % 2 === 0 ? undefined : "final_answer",
        content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text: message }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: index % 2 === 0
        ? { type: "user_message", message }
        : { type: "agent_message", phase: "final_answer", message },
    }),
  ].join("\n");
}

async function sumSizes(paths: string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += (await stat(path)).size;
  return total;
}

async function measure<T>(action: () => Promise<T>): Promise<{
  value: T;
  measurement: Measurement;
}> {
  const startedAt = performance.now();
  const value = await action();
  const measurement = {
    milliseconds: performance.now() - startedAt,
    rssAfterBytes: process.memoryUsage().rss,
  };
  return { value, measurement };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

type Repository = DefaultSessionRepository;

async function requiredDetail(repository: Repository, sessionId: string) {
  const detail = await repository.getSession(sessionId);
  if (detail === null) throw new Error(`Scale session disappeared: ${sessionId}`);
  return detail;
}

function assertMutationIsolation(input: {
  label: string;
  previousListRevision: string;
  currentListRevision: string;
  expectListRevisionChange: boolean;
  previousMutatedRevision: string;
  currentMutatedRevision: string;
  unrelatedRevision: string;
  currentUnrelatedRevision: string;
}): void {
  if (
    (input.currentListRevision !== input.previousListRevision) !==
      input.expectListRevisionChange
  ) {
    throw new Error(`${input.label} produced the wrong listRevision behavior`);
  }
  if (input.currentMutatedRevision === input.previousMutatedRevision) {
    throw new Error(`${input.label} did not change the mutated sessionRevision`);
  }
  if (input.currentUnrelatedRevision !== input.unrelatedRevision) {
    throw new Error(`${input.label} changed an unrelated sessionRevision`);
  }
}

async function assertOldRevisionReadable(
  repository: Repository,
  sessionId: string,
  sessionRevision: string,
): Promise<void> {
  const page = await repository.getItems(sessionId, {
    sessionRevision,
    limit: 1,
  });
  if (page === null || page.sessionRevision !== sessionRevision) {
    throw new Error("An unrelated session's old revision was not readable");
  }
}
