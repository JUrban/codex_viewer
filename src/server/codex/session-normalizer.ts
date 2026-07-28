import type {
  Diagnostic,
  InternalEventItem,
  MessageItem,
  ReasoningUnavailableItem,
  SessionDetail,
  TimelineItem,
} from "../../shared/domain.js";
import type { DecodedRecord, DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";
import type { SessionMetadata } from "./identity-resolver.js";
import {
  MAX_INTERNAL_SUMMARY_CHARS,
  MAX_MESSAGE_CHARS,
  truncateText,
} from "./limits.js";
import {
  ToolAccumulator,
  type NormalizedToolDetail,
  type ToolCall,
  type ToolOutput,
} from "./tool-accumulator.js";

export interface NormalizedSession {
  detail: SessionDetail;
  items: TimelineItem[];
  toolDetails: Map<string, NormalizedToolDetail>;
}

interface MessageCandidate {
  item: MessageItem;
  source: "response" | "event";
  signature: string;
}

export interface SessionNormalizer {
  normalize(decoded: DecodedRollout, metadata: SessionMetadata): NormalizedSession;
}

export class DefaultSessionNormalizer implements SessionNormalizer {
  normalize(decoded: DecodedRollout, metadata: SessionMetadata): NormalizedSession {
    const diagnostics = [...decoded.diagnostics];
    if (decoded.incompleteTail) {
      diagnostics.push({
        code: "incomplete_tail",
        severity: "info",
        message: "The final unterminated rollout fragment is pending and was not decoded.",
        ordinal: null,
      });
    }

    const messages: MessageCandidate[] = [];
    const fixedItems: TimelineItem[] = [];
    const tools = new ToolAccumulator();
    for (const record of decoded.records) {
      consumeRecord(record, messages, fixedItems, tools, diagnostics);
    }
    const deduplicatedMessages = adjacencyDedupe(messages);
    const accumulatedTools = tools.finish();
    const items = [
      ...deduplicatedMessages.map((candidate) => candidate.item),
      ...fixedItems,
      ...accumulatedTools.map((tool) => tool.item),
    ].sort((left, right) => left.ordinal - right.ordinal);
    const firstMessage = items.find((item): item is MessageItem => item.kind === "message");
    const messageCount = items.filter((item) => item.kind === "message").length;
    const toolCount = accumulatedTools.length;
    const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length;
    const fallbackTitle = metadata.title ?? firstUserTitle(items) ?? "Untitled session";
    const detail: SessionDetail = {
      id: decoded.descriptor.id,
      title: fallbackTitle,
      preview: firstMessage === undefined ? null : truncateText(firstMessage.markdown, 180).text,
      cwd: metadata.cwd,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archived: metadata.archived,
      parentId: metadata.parentThreadId,
      childIds: [],
      sourceState: decoded.incompleteTail || warningCount > 0 ? "partial" : "complete",
      messageCount,
      toolCount,
      warningCount,
      diagnostics,
      itemCount: items.length,
    };
    return {
      detail,
      items,
      toolDetails: new Map(accumulatedTools.map((tool) => [tool.item.id, tool.detail])),
    };
  }
}

function consumeRecord(
  record: DecodedRecord,
  messages: MessageCandidate[],
  fixedItems: TimelineItem[],
  tools: ToolAccumulator,
  diagnostics: Diagnostic[],
): void {
  const timestamp = string(record.value.timestamp);
  const payload = record.value.payload;
  if (record.value.type === "response_item" && isObject(payload)) {
    consumeResponse(record.ordinal, timestamp, payload, messages, fixedItems, tools);
    return;
  }
  if (record.value.type === "event_msg" && isObject(payload)) {
    const eventMessage = eventMessageCandidate(record.ordinal, timestamp, payload);
    if (eventMessage !== null) messages.push(eventMessage);
    else fixedItems.push(internalItem(record.ordinal, timestamp, string(payload.type) ?? "event"));
    return;
  }
  if (record.value.type === "session_meta" || record.value.type === "turn_context") return;
  const eventType = string(record.value.type);
  if (eventType !== null) fixedItems.push(internalItem(record.ordinal, timestamp, eventType));
  else diagnostics.push({
    code: "unknown_record",
    severity: "info",
    message: "A record without a recognized type was reduced to a safe diagnostic.",
    ordinal: record.ordinal,
  });
}

function consumeResponse(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
  messages: MessageCandidate[],
  fixedItems: TimelineItem[],
  tools: ToolAccumulator,
): void {
  const type = string(payload.type);
  if (type === "message") {
    const candidate = responseMessageCandidate(ordinal, timestamp, payload);
    if (candidate !== null) messages.push(candidate);
    return;
  }
  if (type === "reasoning") {
    const item: ReasoningUnavailableItem = {
      kind: "reasoning-unavailable",
      id: `reasoning-${ordinal}`,
      ordinal,
      timestamp,
    };
    fixedItems.push(item);
    return;
  }
  const call = toolCall(ordinal, timestamp, payload);
  if (call !== null) {
    tools.addCall(call);
    return;
  }
  const output = toolOutput(payload);
  if (output !== null) {
    tools.addOutput(output);
    return;
  }
  fixedItems.push(internalItem(ordinal, timestamp, type ?? "response_item"));
}

function responseMessageCandidate(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): MessageCandidate | null {
  const role = payload.role;
  if (role !== "user" && role !== "assistant") return null;
  const markdown = contentText(payload.content);
  if (markdown === null) return null;
  const phase = role === "assistant" ? normalizePhase(payload.phase) : null;
  return candidate(ordinal, timestamp, role, phase, markdown, "response");
}

function eventMessageCandidate(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): MessageCandidate | null {
  const type = string(payload.type);
  if (type !== "user_message" && type !== "agent_message") return null;
  const markdown = string(payload.message);
  if (markdown === null) return null;
  const role = type === "user_message" ? "user" : "assistant";
  const phase = type === "agent_message" ? normalizePhase(payload.phase) : null;
  return candidate(
    ordinal,
    timestamp,
    role,
    phase,
    markdown,
    "event",
  );
}

function candidate(
  ordinal: number,
  timestamp: string | null,
  role: "user" | "assistant",
  phase: "commentary" | "final" | null,
  value: string,
  source: "response" | "event",
): MessageCandidate {
  const markdown = truncateText(value, MAX_MESSAGE_CHARS).text;
  return {
    item: { kind: "message", id: `message-${ordinal}`, ordinal, timestamp, role, phase, markdown },
    source,
    signature: `${role}\u0000${phase ?? ""}\u0000${markdown}`,
  };
}

function adjacencyDedupe(messages: MessageCandidate[]): MessageCandidate[] {
  const result: MessageCandidate[] = [];
  for (const message of messages) {
    const previous = result[result.length - 1];
    if (
      previous !== undefined &&
      previous.source !== message.source &&
      previous.signature === message.signature &&
      Math.abs(previous.item.ordinal - message.item.ordinal) <= 2
    ) {
      if (previous.source === "event" && message.source === "response") result[result.length - 1] = message;
      continue;
    }
    result.push(message);
  }
  return result;
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

function contentText(value: unknown): string | null {
  if (!Array.isArray(value)) return string(value);
  const text = value
    .filter(isObject)
    .filter((part) => ["input_text", "output_text", "text"].includes(string(part.type) ?? ""))
    .map((part) => string(part.text))
    .filter((part): part is string => part !== null)
    .join("");
  return text.length === 0 ? null : text;
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

function normalizePhase(value: unknown): "commentary" | "final" | null {
  if (value === "commentary") return "commentary";
  if (value === "final" || value === "final_answer") return "final";
  return null;
}

function internalItem(ordinal: number, timestamp: string | null, eventType: string): InternalEventItem {
  const safeType = truncateText(eventType.replaceAll(/[^A-Za-z0-9_.:-]/g, "_"), 80).text;
  return {
    kind: "internal",
    id: `internal-${ordinal}`,
    ordinal,
    timestamp,
    eventType: safeType,
    summary: truncateText(`Internal event: ${safeType}`, MAX_INTERNAL_SUMMARY_CHARS).text,
  };
}

function firstUserTitle(items: TimelineItem[]): string | null {
  const first = items.find((item): item is MessageItem => item.kind === "message" && item.role === "user");
  if (first === undefined) return null;
  const line = first.markdown.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length === 0 ? null : truncateText(line, 80).text;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
