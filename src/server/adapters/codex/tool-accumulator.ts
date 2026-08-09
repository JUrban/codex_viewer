import type {
  DomainToolDetail as NormalizedToolDetail,
  DomainToolRecord as ToolItem,
} from "../../domain/session-domain.js";
import {
  MAX_PREVIEW_CHARS,
  truncateText,
} from "../../domain/session-text.js";
import { MAX_TOOL_DETAIL_CHARS } from "./limits.js";

export interface ToolCall {
  callId: string;
  ordinal: number;
  timestamp: string | null;
  toolName: string;
  input: string | null;
}

export interface ToolOutput {
  callId: string;
  ordinal: number;
  timestamp: string | null;
  output: string | null;
  failed: boolean;
}

export interface AccumulatedTool {
  item: ToolItem;
  detail: NormalizedToolDetail;
}

export class ToolAccumulator {
  readonly #latestCalls: Map<string, ToolCall>;

  constructor(latestCalls: ReadonlyMap<string, ToolCall> = new Map()) {
    this.#latestCalls = new Map(latestCalls);
  }

  fork(): ToolAccumulator {
    return new ToolAccumulator(this.#latestCalls);
  }

  addCall(call: ToolCall): AccumulatedTool {
    this.#latestCalls.set(call.callId, call);
    const input = truncateNullable(call.input);
    const preview = previewText(call.input);
    const detailTruncated = input.truncated;
    const itemTruncated = detailTruncated || preview.truncated;
    return {
      item: {
        kind: "tool",
        stage: "call",
        id: `tool-${call.ordinal}`,
        ordinal: call.ordinal,
        timestamp: call.timestamp,
        callId: call.callId,
        toolName: call.toolName,
        preview: preview.text,
        truncated: itemTruncated,
        hasDetail: call.input !== null,
      },
      detail: { input: input.text, output: null, truncated: detailTruncated },
    };
  }

  addOutput(output: ToolOutput): AccumulatedTool {
    const call = this.#latestCalls.get(output.callId);
    const input = truncateNullable(call?.input ?? null);
    const result = truncateNullable(output.output);
    const preview = previewText(
      output.output !== null && output.output.length > 0
        ? output.output
        : call?.input ?? null,
    );
    const detailTruncated = input.truncated || result.truncated;
    const itemTruncated = detailTruncated || preview.truncated;
    return {
      item: {
        kind: "tool",
        stage: "output",
        id: `tool-${output.ordinal}`,
        ordinal: output.ordinal,
        timestamp: output.timestamp,
        callId: output.callId,
        toolName: call?.toolName ?? "unknown tool",
        status: output.failed ? "failed" : "completed",
        preview: preview.text,
        truncated: itemTruncated,
        hasDetail: (call?.input !== null && call?.input !== undefined) ||
          output.output !== null,
      },
      detail: {
        input: input.text,
        output: result.text,
        truncated: detailTruncated,
      },
    };
  }
}

function previewText(value: string | null): { text: string | null; truncated: boolean } {
  return value === null
    ? { text: null, truncated: false }
    : truncateText(value, MAX_PREVIEW_CHARS);
}

function truncateNullable(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  const result = truncateText(value, MAX_TOOL_DETAIL_CHARS);
  return { text: result.text, truncated: result.truncated };
}
