export type DomainSessionId = string;
export type DomainItemId = string;
export type DomainCatalogGeneration = number;

export type DomainSourceState = "complete" | "partial" | "unavailable";
export type DomainDiagnosticSeverity = "info" | "warning" | "error";

export interface DomainDiagnostic {
  readonly code: string;
  readonly severity: DomainDiagnosticSeverity;
  readonly message: string;
  readonly ordinal: number | null;
}

export interface DomainAgentIdentity {
  readonly taskName: string | null;
  readonly nickname: string | null;
  readonly role: string | null;
}

export interface DomainSession {
  readonly id: DomainSessionId;
  readonly sourceId: string | null;
  readonly title: string;
  readonly preview: string | null;
  readonly cwd: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly archived: boolean;
  readonly parentId: DomainSessionId | null;
  readonly childIds: readonly DomainSessionId[];
  readonly agent: DomainAgentIdentity | null;
  readonly sourceState: DomainSourceState;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly warningCount: number;
  readonly diagnostics: readonly DomainDiagnostic[];
  readonly itemCount: number;
}

interface DomainTimelineRecordBase {
  readonly id: DomainItemId;
  readonly ordinal: number;
  readonly timestamp: string | null;
}

export interface DomainMessageRecord extends DomainTimelineRecordBase {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  readonly phase: "commentary" | "final" | null;
  readonly markdown: string;
}

export interface DomainDirectiveRecord extends DomainTimelineRecordBase {
  readonly kind: "directive";
  readonly summary: string;
  readonly charCount: number;
  readonly truncated: boolean;
  readonly hasDetail: true;
}

export interface DomainToolRecord extends DomainTimelineRecordBase {
  readonly kind: "tool";
  readonly toolName: string;
  readonly status: "pending" | "completed" | "failed" | "interrupted";
  readonly preview: string | null;
  readonly truncated: boolean;
  readonly hasDetail: boolean;
}

export interface DomainTokenUsageCounters {
  readonly totalTokens: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
}

export interface DomainTokenRecord extends DomainTimelineRecordBase {
  readonly kind: "token";
  readonly tokenUsage: {
    readonly total: DomainTokenUsageCounters | null;
    readonly last: DomainTokenUsageCounters | null;
  };
}

export interface DomainInternalEventRecord extends DomainTimelineRecordBase {
  readonly kind: "internal";
  readonly eventType: string;
  readonly summary: string;
}

export type DomainTimelineRecord =
  | DomainMessageRecord
  | DomainDirectiveRecord
  | DomainToolRecord
  | DomainTokenRecord
  | DomainInternalEventRecord;

export interface DomainToolDetail {
  readonly input: string | null;
  readonly output: string | null;
  readonly truncated: boolean;
}

export interface DomainDirectiveDetail {
  readonly text: string;
  readonly truncated: boolean;
}

export interface NormalizedSession {
  readonly session: DomainSession;
  readonly timeline: readonly DomainTimelineRecord[];
  readonly toolDetails: ReadonlyMap<DomainItemId, DomainToolDetail>;
  readonly directiveDetails: ReadonlyMap<DomainItemId, DomainDirectiveDetail>;
}
