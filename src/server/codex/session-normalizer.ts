import type {
  DomainDiagnostic,
  DomainMessageRecord,
  DomainSession,
  DomainSessionOrigin,
  DomainTimelineRecord,
  NormalizedSession,
} from "../domain/session-domain.js";
import {
  internalItem,
  internalItemFromPayload,
} from "./internal-event-parser.js";
import {
  eventMessageCandidate,
  firstUserTitle,
  normalizeMessages,
  type MessageCandidate,
} from "./message-normalizer.js";
import type { SessionMetadata } from "./identity-resolver.js";
import {
  MAX_PREVIEW_CHARS,
  normalizeSessionTitle,
  truncateText,
} from "./limits.js";
import {
  parseResponseItem,
  type ParsedResponseItem,
} from "./response-item-parser.js";
import type { DecodedRecord, DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";
import { ToolAccumulator } from "./tool-accumulator.js";

export interface SessionNormalizer {
  normalize(
    decoded: DecodedRollout,
    metadata: SessionMetadata,
    origin?: DomainSessionOrigin,
  ): NormalizedSession;
}

export class DefaultSessionNormalizer implements SessionNormalizer {
  normalize(
    decoded: DecodedRollout,
    metadata: SessionMetadata,
    origin: DomainSessionOrigin = DEFAULT_SESSION_ORIGIN,
  ): NormalizedSession {
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
    const fixedItems: DomainTimelineRecord[] = [];
    const tools = new ToolAccumulator();
    for (const record of decoded.records) {
      consumeRecord(record, responseMessages, eventMessages, fixedItems, tools, diagnostics);
    }

    const normalizedMessages = normalizeMessages(responseMessages, eventMessages);
    const accumulatedTools = tools.finish();
    const items = [
      ...normalizedMessages.items,
      ...fixedItems,
      ...accumulatedTools.map((tool) => tool.item),
    ].sort((left, right) => left.ordinal - right.ordinal);
    const firstMessage = items.find(
      (item): item is DomainMessageRecord => item.kind === "message",
    );
    const messageCount = items.filter((item) => item.kind === "message").length;
    const toolCount = accumulatedTools.length;
    const warningCount = diagnostics.filter(
      (diagnostic) => diagnostic.severity !== "info",
    ).length;
    const fallbackTitle = normalizeSessionTitle(metadata.title) ??
      firstUserTitle(items) ??
      "Untitled session";
    const session: DomainSession = {
      id: decoded.descriptor.id,
      sourceId: metadata.threadId,
      origin,
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
      session,
      timeline: items,
      toolDetails: new Map(accumulatedTools.map((tool) => [tool.item.id, tool.detail])),
      directiveDetails: normalizedMessages.directiveDetails,
    };
  }
}

const DEFAULT_SESSION_ORIGIN: DomainSessionOrigin = {
  sourceType: "test",
  sourceInstanceId: "test",
  agentName: "Test",
  agentVersion: null,
  formatVersion: null,
};

function consumeRecord(
  record: DecodedRecord,
  responseMessages: MessageCandidate[],
  eventMessages: MessageCandidate[],
  fixedItems: DomainTimelineRecord[],
  tools: ToolAccumulator,
  diagnostics: DomainDiagnostic[],
): void {
  const timestamp = string(record.value.timestamp);
  const payload = record.value.payload;
  if (record.value.type === "response_item" && isObject(payload)) {
    consumeParsedResponse(
      parseResponseItem(record.ordinal, timestamp, payload),
      responseMessages,
      fixedItems,
      tools,
    );
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
  if (eventType !== null) {
    fixedItems.push(internalItem(record.ordinal, timestamp, eventType));
    return;
  }
  diagnostics.push({
    code: "unknown_record",
    severity: "info",
    message: "A record without a recognized type was reduced to a safe diagnostic.",
    ordinal: record.ordinal,
  });
}

function consumeParsedResponse(
  parsed: ParsedResponseItem,
  responseMessages: MessageCandidate[],
  fixedItems: DomainTimelineRecord[],
  tools: ToolAccumulator,
): void {
  switch (parsed.kind) {
    case "message":
      responseMessages.push(parsed.value);
      break;
    case "timeline":
      fixedItems.push(parsed.value);
      break;
    case "tool_call":
      tools.addCall(parsed.value);
      break;
    case "tool_output":
      tools.addOutput(parsed.value);
      break;
    case "ignored":
      break;
  }
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
