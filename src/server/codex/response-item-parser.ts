import type { DomainTimelineRecord } from "../domain/session-domain.js";
import {
  internalItem,
  reasoningInternalItem,
} from "./internal-event-parser.js";
import {
  responseMessageCandidate,
  type MessageCandidate,
} from "./message-normalizer.js";
import { isObject } from "./rollout-decoder.js";
import type { ToolCall, ToolOutput } from "./tool-accumulator.js";

export type ParsedResponseItem =
  | { readonly kind: "message"; readonly value: MessageCandidate }
  | { readonly kind: "timeline"; readonly value: DomainTimelineRecord }
  | { readonly kind: "tool_call"; readonly value: ToolCall }
  | { readonly kind: "tool_output"; readonly value: ToolOutput }
  | { readonly kind: "ignored" };

export function parseResponseItem(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): ParsedResponseItem {
  const type = string(payload.type);
  if (type === "message") {
    const candidate = responseMessageCandidate(ordinal, timestamp, payload);
    return candidate === null
      ? { kind: "ignored" }
      : { kind: "message", value: candidate };
  }
  if (type === "reasoning") {
    return {
      kind: "timeline",
      value: reasoningInternalItem(ordinal, timestamp, payload.summary),
    };
  }
  const call = toolCall(ordinal, timestamp, payload);
  if (call !== null) return { kind: "tool_call", value: call };
  const output = toolOutput(payload);
  if (output !== null) return { kind: "tool_output", value: output };
  return {
    kind: "timeline",
    value: internalItem(ordinal, timestamp, type ?? "response_item"),
  };
}

function toolCall(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): ToolCall | null {
  const type = string(payload.type);
  if (type !== "function_call" && type !== "custom_tool_call") return null;
  const callId = string(payload.call_id);
  if (callId === null) return null;
  return {
    callId,
    ordinal,
    timestamp,
    toolName: string(payload.name) ?? (type === "custom_tool_call" ? "custom tool" : "function"),
    input: serializeText(payload.arguments ?? payload.input),
  };
}

function toolOutput(payload: Record<string, unknown>): ToolOutput | null {
  const type = string(payload.type);
  if (type !== "function_call_output" && type !== "custom_tool_call_output") return null;
  const callId = string(payload.call_id);
  if (callId === null) return null;
  return {
    callId,
    output: toolOutputText(payload.output),
    failed: payload.success === false || payload.status === "failed",
  };
}

function serializeText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function toolOutputText(value: unknown): string | null {
  if (!Array.isArray(value)) return serializeText(value);
  const parts = value
    .filter(isObject)
    .map((part) => string(part.text) ?? string(part.output_text) ?? serializeText(part))
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? serializeText(value) : parts.join("");
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
