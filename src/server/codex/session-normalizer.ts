import type {
  Diagnostic,
  InjectedContextItem,
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
  MAX_INJECTED_CONTEXT_CHARS,
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
  injectedContextDetails: Map<string, NormalizedInjectedContextDetail>;
}

interface MessageCandidate {
  ordinal: number;
  timestamp: string | null;
  role: "user" | "assistant";
  phase: "commentary" | "final" | null;
  text: string;
}

export interface NormalizedInjectedContextDetail {
  text: string;
  truncated: boolean;
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

    const responseMessages: MessageCandidate[] = [];
    const eventMessages: MessageCandidate[] = [];
    const fixedItems: TimelineItem[] = [];
    const tools = new ToolAccumulator();
    for (const record of decoded.records) {
      consumeRecord(record, responseMessages, eventMessages, fixedItems, tools, diagnostics);
    }
    const normalizedMessages = normalizeMessages(responseMessages, eventMessages);
    const accumulatedTools = tools.finish();
    const items = [
      ...normalizedMessages.items,
      ...normalizedMessages.internalItems,
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
      injectedContextDetails: normalizedMessages.injectedContextDetails,
    };
  }
}

function consumeRecord(
  record: DecodedRecord,
  responseMessages: MessageCandidate[],
  eventMessages: MessageCandidate[],
  fixedItems: TimelineItem[],
  tools: ToolAccumulator,
  diagnostics: Diagnostic[],
): void {
  const timestamp = string(record.value.timestamp);
  const payload = record.value.payload;
  if (record.value.type === "response_item" && isObject(payload)) {
    consumeResponse(record.ordinal, timestamp, payload, responseMessages, fixedItems, tools);
    return;
  }
  if (record.value.type === "event_msg" && isObject(payload)) {
    const eventMessage = eventMessageCandidate(record.ordinal, timestamp, payload);
    if (eventMessage !== null) eventMessages.push(eventMessage);
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
  responseMessages: MessageCandidate[],
  fixedItems: TimelineItem[],
  tools: ToolAccumulator,
): void {
  const type = string(payload.type);
  if (type === "message") {
    const candidate = responseMessageCandidate(ordinal, timestamp, payload);
    if (candidate !== null) responseMessages.push(candidate);
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
  return { ordinal, timestamp, role, phase, text: markdown };
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
  return { ordinal, timestamp, role, phase, text: markdown };
}

function normalizeMessages(
  responseMessages: MessageCandidate[],
  eventMessages: MessageCandidate[],
): {
  items: Array<MessageItem | InjectedContextItem>;
  internalItems: InternalEventItem[];
  injectedContextDetails: Map<string, NormalizedInjectedContextDetail>;
} {
  const items: Array<MessageItem | InjectedContextItem> = [];
  const internalItems: InternalEventItem[] = [];
  const injectedContextDetails = new Map<string, NormalizedInjectedContextDetail>();
  const usedEvents = new Set<number>();

  for (const response of responseMessages) {
    const matchingEvent = nearestMatchingEvent(response, eventMessages, usedEvents);
    if (matchingEvent !== null) usedEvents.add(matchingEvent);
    if (response.role === "assistant" || matchingEvent !== null) {
      items.push(messageItem(response));
      continue;
    }

    const id = `context-${response.ordinal}`;
    const detail = truncateText(response.text, MAX_INJECTED_CONTEXT_CHARS);
    items.push({
      kind: "injected-context",
      id,
      ordinal: response.ordinal,
      timestamp: response.timestamp,
      summary: injectedSummary(response.text),
      charCount: response.text.length,
      truncated: detail.truncated,
      hasDetail: true,
    });
    injectedContextDetails.set(id, detail);
  }

  for (let index = 0; index < eventMessages.length; index += 1) {
    if (usedEvents.has(index)) continue;
    const event = eventMessages[index]!;
    internalItems.push(internalItem(
      event.ordinal,
      event.timestamp,
      event.role === "assistant" ? "propagated_agent_message" : "unmatched_user_event",
    ));
  }

  return { items, internalItems, injectedContextDetails };
}

function nearestMatchingEvent(
  response: MessageCandidate,
  events: MessageCandidate[],
  used: ReadonlySet<number>,
): number | null {
  let match: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < events.length; index += 1) {
    if (used.has(index)) continue;
    const event = events[index]!;
    if (
      event.role !== response.role ||
      event.phase !== response.phase ||
      event.text !== response.text
    ) {
      continue;
    }
    const candidateDistance = Math.abs(event.ordinal - response.ordinal);
    if (candidateDistance <= 2 && candidateDistance < distance) {
      match = index;
      distance = candidateDistance;
    }
  }
  return match;
}

function messageItem(candidate: MessageCandidate): MessageItem {
  return {
    kind: "message",
    id: `message-${candidate.ordinal}`,
    ordinal: candidate.ordinal,
    timestamp: candidate.timestamp,
    role: candidate.role,
    phase: candidate.phase,
    markdown: truncateText(candidate.text, MAX_MESSAGE_CHARS).text,
  };
}

function injectedSummary(value: string): string {
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return truncateText(firstLine ?? "Injected user-role context", MAX_INTERNAL_SUMMARY_CHARS).text;
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
