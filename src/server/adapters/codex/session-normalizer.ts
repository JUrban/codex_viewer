import type {
  DomainDiagnostic,
  DomainAgentInteraction,
  DomainDirectiveDetail,
  DomainMessageRecord,
  DomainSession,
  DomainSessionOrigin,
  DomainTimelineRecord,
  DomainToolDetail,
  InteractionBindingAttempt,
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
} from "./message-normalizer.js";
import type { SessionMetadata } from "./identity-resolver.js";
import type { RolloutDescriptor } from "./path-policy.js";
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
import {
  type AccumulatedUserInput,
  UserInputAccumulator,
} from "./user-input-accumulator.js";
import {
  codexBindingAttemptFrom,
  codexInteractionFromBindingAttempt,
} from "./interaction-parser.js";

export interface SessionNormalizer {
  create(descriptor: RolloutDescriptor): SessionNormalizerAccumulatorState;
  append(
    state: SessionNormalizerAccumulatorState,
    records: readonly DecodedRecord[],
    decoderDiagnostics: readonly DomainDiagnostic[],
  ): SessionNormalizerAccumulatorState;
  materialize(
    state: SessionNormalizerAccumulatorState,
    metadata: SessionMetadata,
    origin?: DomainSessionOrigin,
  ): NormalizedSession;
  normalize(
    decoded: DecodedRollout,
    metadata: SessionMetadata,
    origin?: DomainSessionOrigin,
  ): NormalizedSession;
}

export interface SessionNormalizerAccumulatorState {
  readonly descriptor: RolloutDescriptor;
  readonly timeline: readonly DomainTimelineRecord[];
  readonly directiveDetails: ReadonlyMap<string, DomainDirectiveDetail>;
  readonly toolDetails: ReadonlyMap<string, DomainToolDetail>;
  readonly tools: ToolAccumulator;
  readonly userInputs: UserInputAccumulator;
  readonly decoderDiagnostics: readonly DomainDiagnostic[];
  readonly normalizerDiagnostics: readonly DomainDiagnostic[];
  readonly firstMessage: DomainMessageRecord | null;
  readonly hasFirstUserMessage: boolean;
  readonly firstUserTitle: string | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly bindingAttempt: InteractionBindingAttempt | null;
}

export class DefaultSessionNormalizer implements SessionNormalizer {
  create(descriptor: RolloutDescriptor): SessionNormalizerAccumulatorState {
    return {
      descriptor,
      timeline: [],
      directiveDetails: new Map(),
      toolDetails: new Map(),
      tools: new ToolAccumulator(),
      userInputs: new UserInputAccumulator(),
      decoderDiagnostics: [],
      normalizerDiagnostics: [],
      firstMessage: null,
      hasFirstUserMessage: false,
      firstUserTitle: null,
      messageCount: 0,
      toolCount: 0,
      bindingAttempt: null,
    };
  }

  append(
    state: SessionNormalizerAccumulatorState,
    records: readonly DecodedRecord[],
    decoderDiagnostics: readonly DomainDiagnostic[],
  ): SessionNormalizerAccumulatorState {
    const nextDecoderDiagnostics = decoderDiagnostics.slice(0, MAX_SESSION_DIAGNOSTICS);
    const decoderDiagnosticsUnchanged = sameDiagnostics(
      state.decoderDiagnostics,
      nextDecoderDiagnostics,
    );
    if (records.length === 0 && decoderDiagnosticsUnchanged) {
      return state;
    }

    const items: DomainTimelineRecord[] = [];
    const directiveDetails = new Map(state.directiveDetails);
    const toolDetails = new Map(state.toolDetails);
    const tools = state.tools.fork();
    const userInputs = state.userInputs.fork();
    const normalizerDiagnostics = [...state.normalizerDiagnostics];
    let bindingAttempt = state.bindingAttempt;
    for (const record of records) {
      const attempt = codexBindingAttemptFrom(record);
      if (
        attempt !== null &&
        (bindingAttempt === null || attempt.ordinal >= bindingAttempt.ordinal)
      ) bindingAttempt = attempt;
      consumeRecord(
        record,
        items,
        directiveDetails,
        toolDetails,
        tools,
        userInputs,
        normalizerDiagnostics,
      );
    }

    let firstMessage = state.firstMessage;
    let hasFirstUserMessage = state.hasFirstUserMessage;
    let firstTitle = state.firstUserTitle;
    let messageCount = state.messageCount;
    let toolCount = state.toolCount;
    for (const item of items) {
      if (item.kind === "message") {
        firstMessage ??= item;
        messageCount += 1;
        if (!hasFirstUserMessage && item.role === "user") {
          hasFirstUserMessage = true;
          firstTitle = normalizeSessionTitle(item.markdown);
        }
      } else if (item.kind === "tool" && item.stage === "call") {
        toolCount += 1;
      }
    }

    return {
      ...state,
      timeline: items.length === 0 ? state.timeline : [...state.timeline, ...items],
      directiveDetails: sameMapEntries(state.directiveDetails, directiveDetails)
        ? state.directiveDetails
        : directiveDetails,
      toolDetails: sameMapEntries(state.toolDetails, toolDetails)
        ? state.toolDetails
        : toolDetails,
      tools,
      userInputs,
      decoderDiagnostics: decoderDiagnosticsUnchanged
        ? state.decoderDiagnostics
        : nextDecoderDiagnostics,
      normalizerDiagnostics,
      firstMessage,
      hasFirstUserMessage,
      firstUserTitle: firstTitle,
      messageCount,
      toolCount,
      bindingAttempt,
    };
  }

  materialize(
    state: SessionNormalizerAccumulatorState,
    metadata: SessionMetadata,
    origin: DomainSessionOrigin = DEFAULT_SESSION_ORIGIN,
  ): NormalizedSession {
    const diagnostics = combinedDiagnostics(state);
    const warningCount = diagnostics.filter(
      (diagnostic) => diagnostic.severity !== "info",
    ).length;
    const title = normalizeSessionTitle(metadata.title) ??
      state.firstUserTitle ??
      "Untitled session";
    const session: DomainSession = {
      id: state.descriptor.id,
      sourceId: metadata.threadId,
      origin,
      title,
      preview: state.firstMessage === null
        ? null
        : truncateText(state.firstMessage.markdown, MAX_PREVIEW_CHARS).text,
      cwd: metadata.cwd,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      archived: metadata.archived,
      parentId: metadata.parentThreadId,
      childIds: [],
      agent: metadata.agent ?? null,
      messageCount: state.messageCount,
      toolCount: state.toolCount,
      warningCount,
      diagnostics,
      itemCount: state.timeline.length,
    };
    return {
      session,
      timeline: state.timeline,
      toolDetails: state.toolDetails,
      directiveDetails: state.directiveDetails,
      interaction: interaction(state),
    };
  }

  normalize(
    decoded: DecodedRollout,
    metadata: SessionMetadata,
    origin: DomainSessionOrigin = DEFAULT_SESSION_ORIGIN,
  ): NormalizedSession {
    const state = this.append(
      this.create(decoded.descriptor),
      decoded.records,
      decoded.diagnostics,
    );
    return this.materialize(state, metadata, origin);
  }
}

function combinedDiagnostics(
  state: SessionNormalizerAccumulatorState,
): readonly DomainDiagnostic[] {
  const remaining = MAX_SESSION_DIAGNOSTICS - state.decoderDiagnostics.length;
  return [
    ...state.decoderDiagnostics,
    ...state.normalizerDiagnostics.slice(0, remaining),
  ];
}

function sameDiagnostics(
  left: readonly DomainDiagnostic[],
  right: readonly DomainDiagnostic[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index];
    return candidate !== undefined && item.code === candidate.code &&
      item.severity === candidate.severity && item.message === candidate.message &&
      item.ordinal === candidate.ordinal;
  });
}

function sameMapEntries<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of right) {
    if (left.get(key) !== value) return false;
  }
  return true;
}

function interaction(state: SessionNormalizerAccumulatorState): DomainAgentInteraction {
  return codexInteractionFromBindingAttempt(state.bindingAttempt);
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
  userInputs: UserInputAccumulator,
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
      userInputs,
      diagnostics,
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
  userInputs: UserInputAccumulator,
  diagnostics: DomainDiagnostic[],
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
      if (userInputs.hasRequest(parsed.value.callId)) {
        addUserInput(userInputs.addResponse(parsed.value), items, diagnostics);
      } else {
        addTool(tools.addOutput(parsed.value), items, toolDetails);
      }
      break;
    case "user_input_request":
      addUserInput(userInputs.addRequest(parsed.value), items, diagnostics);
      break;
    case "ignored":
      break;
  }
}

function addUserInput(
  accumulated: AccumulatedUserInput,
  items: DomainTimelineRecord[],
  diagnostics: DomainDiagnostic[],
): void {
  items.push(accumulated.item);
  if (accumulated.malformed) {
    appendDiagnostic(diagnostics, {
      code: "invalid_user_input",
      severity: "warning",
      message: "A request_user_input call or output had an unsupported payload shape.",
      ordinal: accumulated.item.ordinal,
    });
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
