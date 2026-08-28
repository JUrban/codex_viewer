import { Buffer } from "node:buffer";
import type {
  DomainDiagnostic,
  DomainSession,
  DomainSessionOrigin,
  DomainTimelineRecord,
  DomainToolDetail,
  NormalizedSession,
} from "../../domain/session-domain.js";
import {
  normalizeSessionTitle,
  sessionTitleFromMarkdown,
  truncateText,
} from "../../domain/session-text.js";
import { MAX_MESSAGE_CHARS, MAX_SESSION_DIAGNOSTICS } from "../codex/limits.js";
import type { RolloutDescriptor } from "../codex/path-policy.js";
import type { DecodedRecord } from "../codex/rollout-decoder.js";
import { isObject } from "../codex/rollout-decoder.js";
import {
  normalizeToolCall,
  normalizeToolOutput,
  type ToolCall,
} from "../codex/tool-normalizer.js";

const ORDINAL_BLOCK_WIDTH = 1024;
const CLAUDE_SIGNATURE_SCAN_BYTES = 96;
const CLAUDE_NARRATION_WIRE_MARKER = Buffer.from([
  0x42,
  0x09,
  ...Buffer.from("narration", "ascii"),
]);

export interface ClaudeSessionNormalizerState {
  readonly descriptor: RolloutDescriptor;
  readonly recognized: boolean;
  readonly nativeSessionId: string | null;
  readonly agentVersion: string | null;
  readonly cwd: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly explicitTitle: string | null;
  readonly firstUserTitle: string | null;
  readonly timeline: readonly DomainTimelineRecord[];
  readonly toolDetails: ReadonlyMap<string, DomainToolDetail>;
  readonly pendingToolCalls: ReadonlyMap<string, ToolCall>;
  readonly decoderDiagnostics: readonly DomainDiagnostic[];
  readonly messageCount: number;
  readonly toolCount: number;
}

export class ClaudeSessionNormalizer {
  create(descriptor: RolloutDescriptor): ClaudeSessionNormalizerState {
    return {
      descriptor,
      recognized: false,
      nativeSessionId: null,
      agentVersion: null,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      explicitTitle: null,
      firstUserTitle: null,
      timeline: [],
      toolDetails: new Map(),
      pendingToolCalls: new Map(),
      decoderDiagnostics: [],
      messageCount: 0,
      toolCount: 0,
    };
  }

  append(
    state: ClaudeSessionNormalizerState,
    records: readonly DecodedRecord[],
    decoderDiagnostics: readonly DomainDiagnostic[],
  ): ClaudeSessionNormalizerState {
    const diagnostics = decoderDiagnostics.slice(0, MAX_SESSION_DIAGNOSTICS);
    if (records.length === 0 && sameDiagnostics(state.decoderDiagnostics, diagnostics)) {
      return state;
    }

    const timeline: DomainTimelineRecord[] = [];
    const toolDetails = new Map(state.toolDetails);
    const pendingToolCalls = new Map(state.pendingToolCalls);
    let recognized = state.recognized;
    let nativeSessionId = state.nativeSessionId;
    let agentVersion = state.agentVersion;
    let cwd = state.cwd;
    let createdAt = state.createdAt;
    let updatedAt = state.updatedAt;
    let explicitTitle = state.explicitTitle;
    let firstUserTitle = state.firstUserTitle;
    let messageCount = state.messageCount;
    let toolCount = state.toolCount;

    for (const record of records) {
      const value = record.value;
      const timestamp = nonEmptyString(value.timestamp);
      const sessionId = nonEmptyString(value.sessionId);
      nativeSessionId ??= sessionId;
      agentVersion = nonEmptyString(value.version) ?? agentVersion;
      cwd ??= nonEmptyString(value.cwd);
      createdAt ??= timestamp;
      if (timestamp !== null) updatedAt = timestamp;
      if (value.type === "summary") {
        explicitTitle = nonEmptyString(value.summary) ?? explicitTitle;
      }

      const message = isObject(value.message) ? value.message : null;
      if ((value.type !== "user" && value.type !== "assistant") || message === null) {
        continue;
      }
      recognized = true;
      const role = value.type;
      const content = message.content;
      const blocks = Array.isArray(content) ? content.slice(0, ORDINAL_BLOCK_WIDTH) : [content];
      for (const [index, block] of blocks.entries()) {
        const ordinal = record.ordinal * ORDINAL_BLOCK_WIDTH + index;
        if (typeof block === "string") {
          const markdown = meaningfulText(block);
          if (markdown === null) continue;
          timeline.push(messageItem(ordinal, timestamp, role, markdown));
          messageCount += 1;
          if (role === "user" && firstUserTitle === null) {
            firstUserTitle = sessionTitleFromMarkdown(markdown);
          }
          continue;
        }
        if (!isObject(block)) continue;
        if (block.type === "text") {
          const markdown = meaningfulText(block.text);
          if (markdown === null) continue;
          timeline.push(messageItem(ordinal, timestamp, role, markdown));
          messageCount += 1;
          if (role === "user" && firstUserTitle === null) {
            firstUserTitle = sessionTitleFromMarkdown(markdown);
          }
          continue;
        }
        if (role === "assistant" && block.type === "thinking" &&
          hasClaudeNarrationSignature(block.signature)) {
          const markdown = meaningfulText(block.thinking);
          if (markdown === null) continue;
          timeline.push(messageItem(
            ordinal,
            timestamp,
            role,
            markdown,
            "commentary",
            "Narration",
          ));
          messageCount += 1;
          continue;
        }
        if (role === "assistant" && block.type === "tool_use") {
          const callId = nonEmptyString(block.id);
          if (callId === null) continue;
          const call: ToolCall = {
            callId,
            ordinal,
            timestamp,
            toolName: nonEmptyString(block.name) ?? "unknown tool",
            input: serialized(block.input),
          };
          const normalized = normalizeToolCall(call);
          timeline.push(normalized.item);
          toolDetails.set(normalized.item.id, normalized.detail);
          pendingToolCalls.set(callId, call);
          toolCount += 1;
          continue;
        }
        if (role === "user" && block.type === "tool_result") {
          const callId = nonEmptyString(block.tool_use_id);
          if (callId === null) continue;
          const normalized = normalizeToolOutput({
            callId,
            ordinal,
            timestamp,
            output: serializedContent(block.content),
            failed: block.is_error === true,
          }, pendingToolCalls.get(callId));
          timeline.push(normalized.item);
          toolDetails.set(normalized.item.id, normalized.detail);
          pendingToolCalls.delete(callId);
        }
      }
    }

    return {
      ...state,
      recognized,
      nativeSessionId,
      agentVersion,
      cwd,
      createdAt,
      updatedAt,
      explicitTitle,
      firstUserTitle,
      timeline: timeline.length === 0 ? state.timeline : [...state.timeline, ...timeline],
      toolDetails,
      pendingToolCalls,
      decoderDiagnostics: diagnostics,
      messageCount,
      toolCount,
    };
  }

  materialize(
    state: ClaudeSessionNormalizerState,
    origin: DomainSessionOrigin,
  ): NormalizedSession {
    const diagnostics = state.decoderDiagnostics;
    const session: DomainSession = {
      id: state.descriptor.id,
      sourceId: state.nativeSessionId,
      origin,
      title: normalizeSessionTitle(state.explicitTitle) ??
        state.firstUserTitle ??
        "Untitled Claude session",
      cwd: state.cwd,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      archived: state.descriptor.archived,
      parentId: null,
      childIds: [],
      agent: null,
      messageCount: state.messageCount,
      toolCount: state.toolCount,
      warningCount: diagnostics.filter(({ severity }) => severity !== "info").length,
      diagnostics,
      itemCount: state.timeline.length,
    };
    return {
      session,
      timeline: state.timeline,
      toolDetails: state.toolDetails,
      directiveDetails: new Map(),
      interaction: null,
    };
  }
}

export function isClaudeSessionRecords(records: readonly DecodedRecord[]): boolean {
  return records.some(({ value }) =>
    (value.type === "user" || value.type === "assistant") &&
    nonEmptyString(value.sessionId) !== null && isObject(value.message)
  );
}

function messageItem(
  ordinal: number,
  timestamp: string | null,
  role: "user" | "assistant",
  markdown: string,
  phase: "commentary" | "final" | null = role === "assistant" ? "final" : null,
  itemType: string | null = null,
): DomainTimelineRecord {
  return {
    kind: "message",
    id: `message-${ordinal}`,
    ordinal,
    timestamp,
    role,
    phase,
    itemType,
    markdown: truncateText(markdown, MAX_MESSAGE_CHARS).text,
  };
}

function hasClaudeNarrationSignature(value: unknown): boolean {
  const signature = nonEmptyString(value);
  if (signature === null || signature.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    return false;
  }
  const decoded = Buffer.from(signature, "base64");
  const prefix = decoded.subarray(0, CLAUDE_SIGNATURE_SCAN_BYTES);
  return prefix.indexOf(CLAUDE_NARRATION_WIRE_MARKER) !== -1;
}

function meaningfulText(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
}

function serialized(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializedContent(value: unknown): string | null {
  if (!Array.isArray(value)) return serialized(value);
  const text = value
    .filter(isObject)
    .map((part) => nonEmptyString(part.text))
    .filter((part): part is string => part !== null)
    .join("\n\n");
  return text.length > 0 ? text : serialized(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
