import type {
  DomainDiagnostic as Diagnostic,
  DomainDirectiveDetail as NormalizedDirectiveDetail,
  DomainDirectiveRecord as DirectiveItem,
  DomainInternalEventRecord as InternalEventItem,
  DomainMessageRecord as MessageItem,
  DomainReasoningRecord as ReasoningItem,
  DomainSession as SessionDetail,
  DomainTimelineRecord as TimelineItem,
  DomainTokenUsageCounters as TokenUsageCounters,
  NormalizedSession,
} from "../domain/session-domain.js";
import type { DecodedRecord, DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";
import type { SessionMetadata } from "./identity-resolver.js";
import {
  MAX_DIRECTIVE_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_PREVIEW_CHARS,
  normalizeSessionTitle,
  truncateText,
} from "./limits.js";
import {
  ToolAccumulator,
  type ToolCall,
  type ToolOutput,
} from "./tool-accumulator.js";

interface MessageCandidate {
  ordinal: number;
  timestamp: string | null;
  role: "user" | "assistant";
  phase: "commentary" | "final" | null;
  text: string;
  alwaysDirective: boolean;
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
    const fallbackTitle = normalizeSessionTitle(metadata.title) ??
      firstUserTitle(items) ??
      "Untitled session";
    const detail: SessionDetail = {
      id: decoded.descriptor.id,
      sourceId: metadata.threadId,
      title: fallbackTitle,
      preview: firstMessage === undefined
        ? null
        : truncateText(firstMessage.markdown, MAX_PREVIEW_CHARS).text,
      cwd: metadata.cwd,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archived: metadata.archived,
      parentId: metadata.parentThreadId,
      childIds: [],
      agent: metadata.agent ?? null,
      sourceState: decoded.incompleteTail || warningCount > 0 ? "partial" : "complete",
      messageCount,
      toolCount,
      warningCount,
      diagnostics,
      itemCount: items.length,
    };
    return {
      session: detail,
      timeline: items,
      toolDetails: new Map(accumulatedTools.map((tool) => [tool.item.id, tool.detail])),
      directiveDetails: normalizedMessages.directiveDetails,
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
    else fixedItems.push(internalItemFromPayload(record.ordinal, timestamp, payload));
    return;
  }
  if (record.value.type === "session_meta") return;
  if (record.value.type === "turn_context") {
    fixedItems.push(internalItem(record.ordinal, timestamp, "turn_context"));
    return;
  }
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
    const summary = reasoningSummary(payload.summary);
    if (summary === null) return;
    const bounded = truncateText(summary, MAX_MESSAGE_CHARS);
    const item: ReasoningItem = {
      kind: "reasoning",
      id: `reasoning-${ordinal}`,
      ordinal,
      timestamp,
      summary: bounded.text,
      truncated: bounded.truncated,
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
  if (role !== "user" && role !== "assistant" && role !== "developer") return null;
  const markdown = contentText(payload.content);
  if (markdown === null) return null;
  const phase = role === "assistant" ? normalizePhase(payload.phase) : null;
  return {
    ordinal,
    timestamp,
    role: role === "developer" ? "user" : role,
    phase,
    text: markdown,
    alwaysDirective: role === "developer",
  };
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
  return { ordinal, timestamp, role, phase, text: markdown, alwaysDirective: false };
}

function normalizeMessages(
  responseMessages: MessageCandidate[],
  eventMessages: MessageCandidate[],
): {
  items: Array<MessageItem | DirectiveItem>;
  internalItems: InternalEventItem[];
  directiveDetails: Map<string, NormalizedDirectiveDetail>;
} {
  const items: Array<MessageItem | DirectiveItem> = [];
  const internalItems: InternalEventItem[] = [];
  const directiveDetails = new Map<string, NormalizedDirectiveDetail>();
  const usedEvents = new Set<number>();

  for (const response of responseMessages) {
    const matchingEvent = response.alwaysDirective
      ? null
      : nearestMatchingEvent(response, eventMessages, usedEvents);
    if (matchingEvent !== null) usedEvents.add(matchingEvent);
    if (!response.alwaysDirective && (response.role === "assistant" || matchingEvent !== null)) {
      items.push(messageItem(response));
      continue;
    }

    const id = `directive-${response.ordinal}`;
    const detail = truncateText(response.text, MAX_DIRECTIVE_CHARS);
    items.push({
      kind: "directive",
      id,
      ordinal: response.ordinal,
      timestamp: response.timestamp,
      summary: directiveSummary(response.text),
      charCount: response.text.length,
      truncated: detail.truncated,
      hasDetail: true,
    });
    directiveDetails.set(id, detail);
  }

  for (let index = 0; index < eventMessages.length; index += 1) {
    if (usedEvents.has(index)) continue;
    const event = eventMessages[index]!;
    internalItems.push(internalItem(
      event.ordinal,
      event.timestamp,
      event.role === "assistant" ? "unmatched_agent_event" : "unmatched_user_event",
    ));
  }

  return { items, internalItems, directiveDetails };
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

function directiveSummary(value: string): string {
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return truncateText(firstLine ?? "Directive", MAX_PREVIEW_CHARS).text;
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
  if (!Array.isArray(value)) return null;
  const text = value
    .filter(isObject)
    .filter((part) => ["input_text", "output_text", "text"].includes(string(part.type) ?? ""))
    .map((part) => string(part.text))
    .filter((part): part is string => part !== null)
    .join("\n\n");
  return text.length === 0 ? null : text;
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
    summary: truncateText(`Internal event: ${safeType}`, MAX_PREVIEW_CHARS).text,
  };
}

function internalItemFromPayload(
  ordinal: number,
  timestamp: string | null,
  payload: Record<string, unknown>,
): InternalEventItem {
  const eventType = string(payload.type) ?? "event";
  const item = internalItem(ordinal, timestamp, eventType);
  if (eventType !== "token_count" || !isObject(payload.info)) return item;
  const total = tokenUsageCounters(payload.info.total_token_usage);
  const last = tokenUsageCounters(payload.info.last_token_usage);
  return total === null && last === null
    ? item
    : { ...item, tokenUsage: { total, last } };
}

function tokenUsageCounters(value: unknown): TokenUsageCounters | null {
  if (!isObject(value)) return null;
  const counters: TokenUsageCounters = {
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

function firstUserTitle(items: TimelineItem[]): string | null {
  const first = items.find((item): item is MessageItem => item.kind === "message" && item.role === "user");
  return first === undefined ? null : normalizeSessionTitle(first.markdown);
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
