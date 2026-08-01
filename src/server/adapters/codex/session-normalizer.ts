import type {
  DomainDiagnostic,
  DomainDirectiveDetail,
  DomainMessageRecord,
  DomainSession,
  DomainSessionOrigin,
  DomainTimelineRecord,
  DomainToolDetail,
  NormalizedSession,
} from "../../domain/session-domain.js";
import {
  MAX_PREVIEW_CHARS,
  normalizeSessionTitle,
  truncateText,
} from "../../domain/session-text.js";
import { MAX_SESSION_DIAGNOSTICS } from "./limits.js";
import {
  internalItem,
  internalItemFromPayload,
} from "./internal-event-parser.js";
import {
  eventMessage,
  firstUserTitle,
} from "./message-normalizer.js";
import type { SessionMetadata } from "./identity-resolver.js";
import {
  parseResponseItem,
  type ParsedResponseItem,
} from "./response-item-parser.js";
import type { DecodedRecord, DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";
import {
  type AccumulatedTool,
  ToolAccumulator,
} from "./tool-accumulator.js";

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
    const diagnostics = decoded.diagnostics.slice(0, MAX_SESSION_DIAGNOSTICS);

    const items: DomainTimelineRecord[] = [];
    const directiveDetails = new Map<string, DomainDirectiveDetail>();
    const toolDetails = new Map<string, DomainToolDetail>();
    const tools = new ToolAccumulator();
    for (const record of decoded.records) {
      consumeRecord(record, items, directiveDetails, toolDetails, tools, diagnostics);
    }

    const firstMessage = items.find(
      (item): item is DomainMessageRecord => item.kind === "message",
    );
    const messageCount = items.filter((item) => item.kind === "message").length;
    const toolCount = items.filter(
      (item) => item.kind === "tool" && item.stage === "call",
    ).length;
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
      messageCount,
      toolCount,
      warningCount,
      diagnostics,
      itemCount: items.length,
    };
    return {
      session,
      timeline: items,
      toolDetails,
      directiveDetails,
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
  items: DomainTimelineRecord[],
  directiveDetails: Map<string, DomainDirectiveDetail>,
  toolDetails: Map<string, DomainToolDetail>,
  tools: ToolAccumulator,
  diagnostics: DomainDiagnostic[],
): void {
  const timestamp = string(record.value.timestamp);
  const payload = record.value.payload;
  if (record.value.type === "response_item" && isObject(payload)) {
    consumeParsedResponse(
      parseResponseItem(record.ordinal, timestamp, payload),
      items,
      directiveDetails,
      toolDetails,
      tools,
    );
    return;
  }
  if (record.value.type === "event_msg" && isObject(payload)) {
    const message = eventMessage(record.ordinal, timestamp, payload);
    if (message !== null) items.push(message);
    else items.push(internalItemFromPayload(record.ordinal, timestamp, payload));
    return;
  }
  if (record.value.type === "session_meta") return;
  if (record.value.type === "turn_context") {
    items.push(internalItem(record.ordinal, timestamp, "turn_context"));
    return;
  }
  const eventType = string(record.value.type);
  if (eventType !== null) {
    items.push(internalItem(record.ordinal, timestamp, eventType));
    return;
  }
  appendDiagnostic(diagnostics, {
    code: "unknown_record",
    severity: "info",
    message: "A record without a recognized type was reduced to a safe diagnostic.",
    ordinal: record.ordinal,
  });
}

function appendDiagnostic(
  diagnostics: DomainDiagnostic[],
  diagnostic: DomainDiagnostic,
): void {
  if (diagnostics.length < MAX_SESSION_DIAGNOSTICS) {
    diagnostics.push(diagnostic);
  }
}

function consumeParsedResponse(
  parsed: ParsedResponseItem,
  items: DomainTimelineRecord[],
  directiveDetails: Map<string, DomainDirectiveDetail>,
  toolDetails: Map<string, DomainToolDetail>,
  tools: ToolAccumulator,
): void {
  switch (parsed.kind) {
    case "directive":
      items.push(parsed.value.item);
      if (parsed.value.detail !== null) {
        directiveDetails.set(parsed.value.item.id, parsed.value.detail);
      }
      break;
    case "timeline":
      items.push(parsed.value);
      break;
    case "tool_call":
      addTool(tools.addCall(parsed.value), items, toolDetails);
      break;
    case "tool_output":
      addTool(tools.addOutput(parsed.value), items, toolDetails);
      break;
    case "ignored":
      break;
  }
}

function addTool(
  tool: AccumulatedTool,
  items: DomainTimelineRecord[],
  details: Map<string, DomainToolDetail>,
): void {
  items.push(tool.item);
  details.set(tool.item.id, tool.detail);
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
