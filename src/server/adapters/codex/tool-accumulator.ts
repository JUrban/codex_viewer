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
  output: string | null;
  failed: boolean;
}

export interface AccumulatedTool {
  item: ToolItem;
  detail: NormalizedToolDetail;
}

export class ToolAccumulator {
  readonly #calls: ToolCall[] = [];
  readonly #outputs = new Map<string, ToolOutput>();

  addCall(call: ToolCall): void {
    this.#calls.push(call);
  }

  addOutput(output: ToolOutput): void {
    this.#outputs.set(output.callId, output);
  }

  finish(): AccumulatedTool[] {
    return this.#calls.map((call) => {
      const output = this.#outputs.get(call.callId);
      const input = truncateNullable(call.input);
      const result = truncateNullable(output?.output ?? null);
      const previewSource = output?.output ?? call.input;
      const preview = previewSource === null
        ? { text: null, truncated: false }
        : truncateText(previewSource, MAX_PREVIEW_CHARS);
      const truncated = input.truncated || result.truncated || preview.truncated;
      return {
        item: {
          kind: "tool",
          id: `tool-${call.ordinal}`,
          ordinal: call.ordinal,
          timestamp: call.timestamp,
          toolName: call.toolName,
          status: toolStatus(output),
          preview: preview.text,
          truncated,
          hasDetail: call.input !== null || output?.output != null,
        },
        detail: { input: input.text, output: result.text, truncated },
      };
    });
  }
}

function toolStatus(output: ToolOutput | undefined): ToolItem["status"] {
  if (output === undefined) return "pending";
  return output.failed ? "failed" : "completed";
}

function truncateNullable(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  const result = truncateText(value, MAX_TOOL_DETAIL_CHARS);
  return { text: result.text, truncated: result.truncated };
}
