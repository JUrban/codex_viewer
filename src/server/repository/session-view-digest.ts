import { createHash, type Hash } from "node:crypto";
import type {
  DomainAgentIdentity,
  DomainDiagnostic,
  DomainSession,
  DomainTimelineRecord,
  DomainTokenUsageCounters,
  NormalizedSession,
} from "../domain/session-domain.js";

export function digestSessionView(normalized: NormalizedSession): string {
  const writer = new DigestWriter();
  writeSession(writer, normalized.session);
  writer.array("timeline", normalized.timeline, writeTimelineItem);
  writer.map("toolDetails", normalized.toolDetails, (entry, detail) => {
    entry.nullableString("input", detail.input);
    entry.nullableString("output", detail.output);
    entry.boolean("truncated", detail.truncated);
  });
  writer.map("directiveDetails", normalized.directiveDetails, (entry, detail) => {
    entry.string("text", detail.text);
    entry.boolean("truncated", detail.truncated);
  });
  return writer.digest();
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

function writeTimelineItem(writer: DigestWriter, item: DomainTimelineRecord): void {
  writer.string("kind", item.kind);
  writer.string("id", item.id);
  writer.number("ordinal", item.ordinal);
  writer.nullableString("timestamp", item.timestamp);
  switch (item.kind) {
    case "message":
      writer.string("role", item.role);
      writer.nullableString("phase", item.phase);
      writer.string("markdown", item.markdown);
      return;
    case "directive":
      writer.string("summary", item.summary);
      writer.number("charCount", item.charCount);
      writer.boolean("truncated", item.truncated);
      writer.boolean("hasDetail", item.hasDetail);
      return;
    case "tool":
      writer.string("toolName", item.toolName);
      writer.string("status", item.status);
      writer.nullableString("preview", item.preview);
      writer.boolean("truncated", item.truncated);
      writer.boolean("hasDetail", item.hasDetail);
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
  readonly #hash: Hash;

  constructor(hash: Hash = createHash("sha256")) {
    this.#hash = hash;
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

  map<T>(
    name: string,
    values: ReadonlyMap<string, T>,
    write: (writer: DigestWriter, value: T) => void,
  ): void {
    const entries = [...values.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );
    this.#field(name, "map");
    this.#token(String(entries.length));
    for (const [key, value] of entries) {
      this.valueString(key);
      write(this, value);
      this.#token("entry-end");
    }
  }

  valueString(value: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    this.#hash.update(`value:${bytes}:`, "utf8");
    this.#hash.update(value, "utf8");
    this.#hash.update(";", "utf8");
  }

  digest(): string {
    return this.#hash.digest("hex");
  }

  #field(name: string, type: string): void {
    this.#token(`field:${type}`);
    this.valueString(name);
  }

  #token(value: string): void {
    this.#hash.update(`${value.length}:${value};`, "utf8");
  }
}
