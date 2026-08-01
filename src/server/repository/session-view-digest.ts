import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { TimelinePrefixRevision } from "../../shared/domain.js";
import type {
  DomainAgentIdentity,
  DomainDiagnostic,
  DomainSession,
  DomainTimelineRecord,
  DomainTokenUsageCounters,
  NormalizedSession,
} from "../domain/session-domain.js";

export function digestSessionView(normalized: NormalizedSession): string {
  return deriveSessionView(normalized, Buffer.alloc(32)).viewDigest;
}

export interface DerivedSessionView {
  readonly viewDigest: string;
  readonly timelinePrefixIndex: TimelinePrefixIndex;
}

const PREFIX_BYTES = 24;
const PREFIX_PROTOCOL = "timeline-prefix-v1";

export function deriveSessionView(
  normalized: NormalizedSession,
  prefixKey: Uint8Array,
): DerivedSessionView {
  const hash = createHash("sha256");
  const writer = new DigestWriter((chunk) => hash.update(chunk));
  const states = new Uint8Array((normalized.timeline.length + 1) * PREFIX_BYTES);
  let previousOrdinal: number | undefined;
  let itemIndex = 0;
  let state = createHmac("sha256", prefixKey)
    .update(PREFIX_PROTOCOL, "utf8")
    .update("\0", "utf8")
    .update(normalized.session.id, "utf8")
    .digest()
    .subarray(0, PREFIX_BYTES);
  states.set(state, 0);
  writeSession(writer, normalized.session);
  writer.arrayEncoded(
    "timeline",
    normalized.timeline,
    (entry, item) => writeTimelineItem(entry, item, normalized),
    (item, encoded) => {
      if (
        !Number.isSafeInteger(item.ordinal) ||
        item.ordinal < 1 ||
        (previousOrdinal !== undefined && item.ordinal <= previousOrdinal)
      ) {
        throw new Error("Timeline ordinals must be strictly increasing positive integers");
      }
      previousOrdinal = item.ordinal;
      itemIndex += 1;
      state = createHmac("sha256", prefixKey)
        .update(state)
        .update(encoded)
        .digest()
        .subarray(0, PREFIX_BYTES);
      states.set(state, itemIndex * PREFIX_BYTES);
    },
  );
  return {
    viewDigest: hash.digest("hex"),
    timelinePrefixIndex: new TimelinePrefixIndex(itemIndex, states),
  };
}

export interface TimelinePrefixBoundary {
  readonly throughOrdinal: number;
  readonly timelinePrefixRevision: TimelinePrefixRevision;
}

export class TimelinePrefixIndex {
  readonly #states: Uint8Array;

  constructor(itemCount: number, states: Uint8Array) {
    if (states.byteLength !== (itemCount + 1) * PREFIX_BYTES) {
      throw new Error("Timeline prefix index has an invalid byte length");
    }
    this.#states = states.slice();
  }

  get byteLength(): number {
    return this.#states.byteLength;
  }

  boundaryAt(
    timeline: readonly DomainTimelineRecord[],
    throughOrdinal: number,
  ): TimelinePrefixBoundary | null {
    const maximumOrdinal = timeline.at(-1)?.ordinal ?? 0;
    if (timeline.length + 1 !== this.#states.byteLength / PREFIX_BYTES) {
      throw new Error("Timeline prefix index does not match the timeline");
    }
    if (throughOrdinal > maximumOrdinal) return null;
    let low = 0;
    let high = timeline.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (timeline[middle]!.ordinal <= throughOrdinal) low = middle + 1;
      else high = middle;
    }
    return this.#boundary(timeline, low);
  }

  boundaryAtOrBefore(
    timeline: readonly DomainTimelineRecord[],
    throughOrdinal: number,
  ): TimelinePrefixBoundary {
    const maximumOrdinal = timeline.at(-1)?.ordinal ?? 0;
    return this.boundaryAt(timeline, Math.min(throughOrdinal, maximumOrdinal))!;
  }

  matches(
    timeline: readonly DomainTimelineRecord[],
    boundary: TimelinePrefixBoundary,
    candidate: TimelinePrefixRevision,
  ): boolean {
    const encoded = Buffer.from(candidate, "base64url");
    if (encoded.byteLength !== PREFIX_BYTES) return false;
    const slotIndex = boundary.throughOrdinal === 0
      ? 0
      : upperBound(timeline, boundary.throughOrdinal);
    const slot = slotIndex === 0 ||
        timeline[slotIndex - 1]?.ordinal === boundary.throughOrdinal
      ? this.#slot(slotIndex)
      : null;
    return slot !== null && timingSafeEqual(slot, encoded);
  }

  #boundary(
    timeline: readonly DomainTimelineRecord[],
    slot: number,
  ): TimelinePrefixBoundary {
    return {
      throughOrdinal: slot === 0 ? 0 : timeline[slot - 1]!.ordinal,
      timelinePrefixRevision: Buffer.from(this.#slot(slot))
        .toString("base64url") as TimelinePrefixRevision,
    };
  }

  #slot(index: number): Uint8Array {
    const start = index * PREFIX_BYTES;
    return this.#states.subarray(start, start + PREFIX_BYTES);
  }
}

function upperBound(
  timeline: readonly DomainTimelineRecord[],
  ordinal: number,
): number {
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (timeline[middle]!.ordinal <= ordinal) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function isTimelinePrefixRevision(
  value: string,
): value is TimelinePrefixRevision {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}

function writeSession(writer: DigestWriter, session: DomainSession): void {
  writer.string("session.id", session.id);
  writer.nullableString("session.sourceId", session.sourceId);
  writer.object("session.origin", (entry) => {
    entry.string("sourceType", session.origin.sourceType);
    entry.string("sourceInstanceId", session.origin.sourceInstanceId);
    entry.string("agentName", session.origin.agentName);
    entry.nullableString("agentVersion", session.origin.agentVersion);
    entry.nullableString("formatVersion", session.origin.formatVersion);
  });
  writer.string("session.title", session.title);
  writer.nullableString("session.preview", session.preview);
  writer.nullableString("session.cwd", session.cwd);
  writer.nullableString("session.createdAt", session.createdAt);
  writer.nullableString("session.updatedAt", session.updatedAt);
  writer.boolean("session.archived", session.archived);
  writer.nullableString("session.parentId", session.parentId);
  writer.array(
    "session.childIds",
    session.childIds,
    (entry, childId) => entry.valueString(childId),
  );
  writer.nullableObject("session.agent", session.agent, writeAgent);
  writer.number("session.messageCount", session.messageCount);
  writer.number("session.toolCount", session.toolCount);
  writer.number("session.warningCount", session.warningCount);
  writer.array("session.diagnostics", session.diagnostics, writeDiagnostic);
  writer.number("session.itemCount", session.itemCount);
}

function writeAgent(writer: DigestWriter, agent: DomainAgentIdentity): void {
  writer.nullableString("taskName", agent.taskName);
  writer.nullableString("nickname", agent.nickname);
  writer.nullableString("role", agent.role);
}

function writeDiagnostic(writer: DigestWriter, diagnostic: DomainDiagnostic): void {
  writer.string("code", diagnostic.code);
  writer.string("severity", diagnostic.severity);
  writer.string("message", diagnostic.message);
  writer.nullableNumber("ordinal", diagnostic.ordinal);
}

function writeTimelineItem(
  writer: DigestWriter,
  item: DomainTimelineRecord,
  normalized: NormalizedSession,
): void {
  writer.string("kind", item.kind);
  writer.string("id", item.id);
  writer.number("ordinal", item.ordinal);
  writer.nullableString("timestamp", item.timestamp);
  switch (item.kind) {
    case "message":
      writer.string("role", item.role);
      writer.nullableString("phase", item.phase);
      writer.nullableString("itemType", item.itemType ?? null);
      writer.string("markdown", item.markdown);
      return;
    case "directive":
      writer.number("charCount", item.charCount);
      writer.boolean("hasDetail", item.hasDetail);
      if (!item.hasDetail) {
        writer.string("text", item.text);
        return;
      }
      writer.string("summary", item.summary);
      writer.boolean("truncated", item.truncated);
      writer.nullableObject(
        "detail",
        normalized.directiveDetails.get(item.id) ?? null,
        (entry, detail) => {
          entry.string("text", detail.text);
          entry.boolean("truncated", detail.truncated);
        },
      );
      return;
    case "tool":
      writer.string("stage", item.stage);
      writer.string("callId", item.callId);
      writer.string("toolName", item.toolName);
      if (item.stage === "output") writer.string("status", item.status);
      writer.nullableString("preview", item.preview);
      writer.boolean("truncated", item.truncated);
      writer.boolean("hasDetail", item.hasDetail);
      writer.nullableObject(
        "detail",
        normalized.toolDetails.get(item.id) ?? null,
        (entry, detail) => {
          entry.nullableString("input", detail.input);
          entry.nullableString("output", detail.output);
          entry.boolean("truncated", detail.truncated);
        },
      );
      return;
    case "user_input":
      writer.string("stage", item.stage);
      writer.string("callId", item.callId);
      if (item.stage === "request") {
        writer.array("questions", item.questions, (entry, question) => {
          entry.string("id", question.id);
          entry.string("header", question.header);
          entry.string("question", question.question);
          entry.array("options", question.options, (optionEntry, option) => {
            optionEntry.string("label", option.label);
            optionEntry.string("description", option.description);
          });
        });
        return;
      }
      writer.string("outcome", item.outcome);
      if (item.outcome === "answered") {
        writer.array("answers", item.answers, (entry, answer) => {
          entry.string("questionId", answer.questionId);
          entry.array("answers", answer.answers, (answerEntry, value) => {
            answerEntry.valueString(value);
          });
        });
      } else if (item.outcome === "unavailable") {
        writer.string("summary", item.summary);
      }
      return;
    case "token":
      writer.nullableObject("tokenUsage.total", item.tokenUsage.total, writeTokenCounters);
      writer.nullableObject("tokenUsage.last", item.tokenUsage.last, writeTokenCounters);
      return;
    case "internal":
      writer.string("eventType", item.eventType);
      writer.string("summary", item.summary);
      return;
  }
}

function writeTokenCounters(
  writer: DigestWriter,
  counters: DomainTokenUsageCounters,
): void {
  writer.nullableNumber("totalTokens", counters.totalTokens);
  writer.nullableNumber("inputTokens", counters.inputTokens);
  writer.nullableNumber("cachedInputTokens", counters.cachedInputTokens);
  writer.nullableNumber("cacheWriteInputTokens", counters.cacheWriteInputTokens);
  writer.nullableNumber("outputTokens", counters.outputTokens);
  writer.nullableNumber("reasoningOutputTokens", counters.reasoningOutputTokens);
}

class DigestWriter {
  constructor(
    private readonly update: (chunk: string | Uint8Array) => void,
  ) {
  }

  string(name: string, value: string): void {
    this.#field(name, "string");
    this.valueString(value);
  }

  nullableString(name: string, value: string | null): void {
    this.#field(name, "nullable-string");
    if (value === null) {
      this.#token("null");
      return;
    }
    this.valueString(value);
  }

  boolean(name: string, value: boolean): void {
    this.#field(name, "boolean");
    this.#token(value ? "true" : "false");
  }

  number(name: string, value: number): void {
    this.#field(name, "number");
    this.#token(String(value));
  }

  nullableNumber(name: string, value: number | null): void {
    this.#field(name, "nullable-number");
    this.#token(value === null ? "null" : String(value));
  }

  object(name: string, write: (writer: DigestWriter) => void): void {
    this.#field(name, "object-start");
    write(this);
    this.#token("object-end");
  }

  nullableObject<T>(
    name: string,
    value: T | null,
    write: (writer: DigestWriter, value: T) => void,
  ): void {
    this.#field(name, "nullable-object");
    if (value === null) {
      this.#token("null");
      return;
    }
    this.#token("object-start");
    write(this, value);
    this.#token("object-end");
  }

  array<T>(
    name: string,
    values: readonly T[],
    write: (writer: DigestWriter, value: T) => void,
  ): void {
    this.#field(name, "array");
    this.#token(String(values.length));
    for (const value of values) {
      this.#token("item-start");
      write(this, value);
      this.#token("item-end");
    }
  }

  arrayEncoded<T>(
    name: string,
    values: readonly T[],
    write: (writer: DigestWriter, value: T) => void,
    observe: (value: T, encoded: Uint8Array) => void,
  ): void {
    this.#field(name, "array");
    this.#token(String(values.length));
    for (const value of values) {
      const chunks: Buffer[] = [];
      const itemWriter = new DigestWriter((chunk) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
      });
      write(itemWriter, value);
      const encoded = Buffer.concat(chunks);
      this.#token("item-start");
      this.update(encoded);
      this.#token("item-end");
      observe(value, encoded);
    }
  }

  valueString(value: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    this.update(`value:${bytes}:`);
    this.update(value);
    this.update(";");
  }

  #field(name: string, type: string): void {
    this.#token(`field:${type}`);
    this.valueString(name);
  }

  #token(value: string): void {
    this.update(`${value.length}:${value};`);
  }
}
