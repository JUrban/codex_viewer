import type {
  DomainDirectiveDetail,
  DomainDirectiveRecord,
  DomainMessageRecord,
  DomainTimelineRecord,
} from "../domain/session-domain.js";
import {
  MAX_DIRECTIVE_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_PREVIEW_CHARS,
  normalizeSessionTitle,
  truncateText,
} from "./limits.js";
import { isObject } from "./rollout-decoder.js";

export interface MessageCandidate {
  readonly ordinal: number;
  readonly timestamp: string | null;
  readonly role: "user" | "assistant";
  readonly phase: "commentary" | "final" | null;
  readonly text: string;
  readonly alwaysDirective: boolean;
}

export interface NormalizedMessages {
  readonly items: Array<DomainMessageRecord | DomainDirectiveRecord>;
  readonly directiveDetails: Map<string, DomainDirectiveDetail>;
}

export function responseMessageCandidate(
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

export function eventMessageCandidate(
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

export function normalizeMessages(
  responseMessages: readonly MessageCandidate[],
  eventMessages: readonly MessageCandidate[],
): NormalizedMessages {
  const items: Array<DomainMessageRecord | DomainDirectiveRecord> = [];
  const directiveDetails = new Map<string, DomainDirectiveDetail>();
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
    addDirective(response, items, directiveDetails);
  }

  for (let index = 0; index < eventMessages.length; index += 1) {
    if (usedEvents.has(index)) continue;
    addDirective(eventMessages[index]!, items, directiveDetails);
  }

  return { items, directiveDetails };
}

export function firstUserTitle(items: readonly DomainTimelineRecord[]): string | null {
  const first = items.find(
    (item): item is DomainMessageRecord => item.kind === "message" && item.role === "user",
  );
  return first === undefined ? null : normalizeSessionTitle(first.markdown);
}

function addDirective(
  candidate: MessageCandidate,
  items: Array<DomainMessageRecord | DomainDirectiveRecord>,
  directiveDetails: Map<string, DomainDirectiveDetail>,
): void {
  const id = `directive-${candidate.ordinal}`;
  const detail = truncateText(candidate.text, MAX_DIRECTIVE_CHARS);
  items.push({
    kind: "directive",
    id,
    ordinal: candidate.ordinal,
    timestamp: candidate.timestamp,
    summary: directiveSummary(candidate.text),
    charCount: candidate.text.length,
    truncated: detail.truncated,
    hasDetail: true,
  });
  directiveDetails.set(id, detail);
}

function nearestMatchingEvent(
  response: MessageCandidate,
  events: readonly MessageCandidate[],
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

function messageItem(candidate: MessageCandidate): DomainMessageRecord {
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

function normalizePhase(value: unknown): "commentary" | "final" | null {
  if (value === "commentary") return "commentary";
  if (value === "final" || value === "final_answer") return "final";
  return null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
