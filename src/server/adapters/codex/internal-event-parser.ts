import type {
  DomainInternalEventRecord,
  DomainTokenRecord,
  DomainTokenUsageCounters,
} from "../../domain/session-domain.js";
import {
  MAX_PREVIEW_CHARS,
  truncateText,
} from "../../domain/session-text.js";
import { isObject } from "./rollout-decoder.js";

export function reasoningInternalItem(
  ordinal: number,
  timestamp: string | null,
  value: unknown,
): DomainInternalEventRecord {
  const item = internalItem(ordinal, timestamp, "reasoning");
  const summary = reasoningSummary(value);
  return summary === null
    ? item
    : { ...item, summary: truncateText(summary, MAX_PREVIEW_CHARS).text };
}

export function internalItem(
  ordinal: number,
  timestamp: string | null,
  eventType: string,
): DomainInternalEventRecord {
  const safeType = truncateText(eventType.replaceAll(/[^A-Za-z0-9_.:-]/g, "_"), 80).text;
  return {
    kind: "internal",
    id: `internal-${ordinal}`,
    ordinal,
    timestamp,
    eventType: safeType,
    summary: truncateText(`Internal event: ${safeType}`, MAX_PREVIEW_CHARS).text,
  };
}

export function internalItemFromPayload(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): DomainInternalEventRecord | DomainTokenRecord {
  const eventType = string(payload.type) ?? "event";
  if (eventType !== "token_count") return internalItem(ordinal, timestamp, eventType);
  const info = isObject(payload.info) ? payload.info : null;
  return {
    kind: "token",
    id: `token-${ordinal}`,
    ordinal,
    timestamp,
    tokenUsage: {
      total: tokenUsageCounters(info?.total_token_usage),
      last: tokenUsageCounters(info?.last_token_usage),
    },
  };
}

function reasoningSummary(value: unknown): string | null {
  if (!Array.isArray(value)) return nonBlankString(value);
  const text = value
    .map((part) => {
      if (typeof part === "string") return nonBlankString(part);
      if (!isObject(part)) return null;
      const type = string(part.type);
      return type === "summary_text" || type === "text" ? nonBlankString(part.text) : null;
    })
    .filter((part): part is string => part !== null)
    .join("\n\n");
  return nonBlankString(text);
}

function tokenUsageCounters(value: unknown): DomainTokenUsageCounters | null {
  if (!isObject(value)) return null;
  const counters: DomainTokenUsageCounters = {
    totalTokens: tokenCount(value.total_tokens),
    inputTokens: tokenCount(value.input_tokens),
    cachedInputTokens: tokenCount(value.cached_input_tokens),
    cacheWriteInputTokens: tokenCount(value.cache_write_input_tokens),
    outputTokens: tokenCount(value.output_tokens),
    reasoningOutputTokens: tokenCount(value.reasoning_output_tokens),
  };
  return Object.values(counters).some((count) => count !== null) ? counters : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
