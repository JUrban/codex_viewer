import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createSessionRepository } from "../src/server/repository/create-session-repository.js";

const SESSION_COUNT = 3_000;
const MIN_CORPUS_BYTES = 100 * 1024 * 1024;
const FILLER_CHARS = 36_000;

interface Measurement {
  milliseconds: number;
  rssBytes: number;
}

const root = await mkdtemp("/private/tmp/codex-viewer-scale-");
const sessions = join(root, "sessions", "2026", "07", "28");
let peakRssBytes = process.memoryUsage().rss;

try {
  await mkdir(sessions, { recursive: true });
  const paths = await generateCorpus(sessions);
  const totalBytes = await sumSizes(paths);
  if (totalBytes < MIN_CORPUS_BYTES) {
    throw new Error(`Synthetic corpus was only ${totalBytes} bytes`);
  }

  // A corrupt newest state file proves that catalog construction keeps JSONL as
  // the correctness fallback when SQLite is unavailable.
  await writeFile(join(root, "state_99.sqlite"), "not a sqlite database");

  const repository = await createSessionRepository(root);
  const coldCatalog = await measure(() => repository.list({ limit: 200 }));
  const firstList = coldCatalog.value;
  const search = await measure(() => repository.list({ q: "needle-scale", limit: 200 }));
  const absentSearch = await measure(() =>
    repository.list({ q: "absent-search-value", limit: 200 }));
  const selected = search.value.sessions[0];
  if (selected === undefined) throw new Error("Scale search did not find the special session");
  const detailFirstPage = await measure(async () => {
    const detail = await repository.getSession(selected.session.id);
    const items = await repository.getItems(selected.session.id, {
      generation: detail?.generation,
      limit: 50,
    });
    return { detail, items };
  });
  const tool = detailFirstPage.value.items?.items.find((item) => item.kind === "tool");
  if (tool?.kind !== "tool") throw new Error("Large tool was not normalized");
  const toolDetail = await repository.getToolDetail(
    selected.session.id,
    tool.id,
    { generation: detailFirstPage.value.items!.generation },
  );
  if (!toolDetail?.truncated) throw new Error("Large tool detail was not truncated");
  const message = detailFirstPage.value.items?.items.find((item) => item.kind === "message");
  if (message?.kind !== "message" || message.markdown.length !== 1_000_000) {
    throw new Error("Long message limit was not exercised");
  }

  const specialPath = paths[0]!;
  const beforeMutation = firstList.generation;
  await writeFile(specialPath, `${await rollout(0, "truncate-replacement", 128)}\n`);
  const afterTruncate = (await repository.list({ limit: 1 })).generation;
  const replacement = `${specialPath}.replacement`;
  await writeFile(replacement, `${await rollout(0, "atomic-replacement", 256)}\n`);
  await rename(replacement, specialPath);
  const afterReplace = (await repository.list({ limit: 1 })).generation;

  let permissionProbe: "unavailable" | "portable-skip" = "portable-skip";
  try {
    await chmod(specialPath, 0);
    const unavailable = await repository.getSession(selected.session.id);
    if (unavailable?.session.sourceState === "unavailable") permissionProbe = "unavailable";
  } finally {
    await chmod(specialPath, 0o600);
  }

  const result = {
    corpus: {
      directory: "/private/tmp/codex-viewer-scale-<random>",
      sessionCount: SESSION_COUNT,
      bytes: totalBytes,
      sqliteMode: (await repository.getStatus()).catalogMode,
    },
    timingMs: {
      coldCatalog: round(coldCatalog.measurement.milliseconds),
      search: round(search.measurement.milliseconds),
      boundedAbsentSearch: round(absentSearch.measurement.milliseconds),
      detailFirstPage: round(detailFirstPage.measurement.milliseconds),
    },
    memory: {
      peakRssBytes,
      coldCatalogRssBytes: coldCatalog.measurement.rssBytes,
      searchRssBytes: search.measurement.rssBytes,
      detailFirstPageRssBytes: detailFirstPage.measurement.rssBytes,
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
      before: beforeMutation,
      afterTruncate,
      afterReplace,
      generationsAdvanced: beforeMutation < afterTruncate && afterTruncate < afterReplace,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
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
      paths.push(path);
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
    rssBytes: process.memoryUsage().rss,
  };
  peakRssBytes = Math.max(peakRssBytes, measurement.rssBytes);
  return { value, measurement };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
