import type { ApiWarning, SearchMatch } from "../../shared/api-contract.js";
import type { MessageItem, SessionId } from "../../shared/domain.js";
import type { NormalizedSession } from "../codex/session-normalizer.js";
import { MAX_PREVIEW_CHARS, truncateText } from "../codex/limits.js";

export const MAX_SEARCH_QUERY_CHARS = 200;

export interface SearchDocument {
  sessionId: SessionId;
  title: string;
  agentTerms: string[];
  cwd: string;
  messages: string[];
}

export interface SearchBudget {
  maxScannedBytes: number;
  maxResults: number;
  maxExcerptChars: number;
  maxDurationMs: number;
}

export const DEFAULT_SEARCH_BUDGET: SearchBudget = {
  maxScannedBytes: 16 * 1024 * 1024,
  maxResults: 200,
  maxExcerptChars: MAX_PREVIEW_CHARS,
  maxDurationMs: 75,
};

export interface SearchResult {
  matches: Map<SessionId, SearchMatch[]>;
  partial: boolean;
  warnings: ApiWarning[];
}

export function buildSearchDocument(normalized: NormalizedSession): SearchDocument {
  return {
    sessionId: normalized.detail.id,
    title: normalized.detail.title,
    agentTerms: normalized.detail.agent === null
      ? []
      : Object.values(normalized.detail.agent).filter((value): value is string => value !== null),
    cwd: normalized.detail.cwd ?? "",
    messages: normalized.items
      .filter((item): item is MessageItem => item.kind === "message")
      .map((item) => item.markdown),
  };
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function searchDocuments(
  documents: readonly SearchDocument[],
  rawQuery: string,
  budget: SearchBudget = DEFAULT_SEARCH_BUDGET,
  now: () => number = performance.now.bind(performance),
): SearchResult {
  const query = normalizeSearchText(rawQuery.trim());
  const matches = new Map<SessionId, SearchMatch[]>();
  let scannedBytes = 0;
  let partialCode: string | null = null;
  const startedAt = now();

  outer: for (const document of documents) {
    if (now() - startedAt >= budget.maxDurationMs) {
      partialCode = "search_time_budget";
      break;
    }
    const documentMatches: SearchMatch[] = [];
    for (const [field, values] of fields(document)) {
      for (const value of values) {
        scannedBytes += Buffer.byteLength(value, "utf8");
        if (scannedBytes > budget.maxScannedBytes) {
          partialCode = "search_byte_budget";
          break outer;
        }
        const index = normalizeSearchText(value).indexOf(query);
        if (index >= 0) {
          documentMatches.push({ field, excerpt: excerpt(value, index, query.length, budget.maxExcerptChars) });
          break;
        }
      }
    }
    if (documentMatches.length > 0) {
      if (matches.size >= budget.maxResults) {
        partialCode = "search_result_budget";
        break;
      }
      matches.set(document.sessionId, documentMatches);
    }
  }

  return {
    matches,
    partial: partialCode !== null,
    warnings: partialCode === null
      ? []
      : [{ code: partialCode, message: "Search stopped at a configured safety budget; results may be incomplete." }],
  };
}

function fields(document: SearchDocument): Array<["title" | "cwd" | "message", string[]]> {
  return [
    ["title", [document.title, ...(document.agentTerms ?? [])]],
    ["cwd", [document.cwd]],
    ["message", document.messages],
  ];
}

function excerpt(value: string, index: number, queryLength: number, limit: number): string {
  if (value.length <= limit) return value;
  const context = Math.max(0, Math.floor((limit - queryLength) / 2));
  const start = Math.max(0, Math.min(index - context, value.length - limit));
  const result = truncateText(value.slice(start), limit).text;
  return `${start > 0 ? "…" : ""}${result}${start + limit < value.length ? "…" : ""}`;
}
