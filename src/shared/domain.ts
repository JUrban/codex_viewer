export type SessionId = string;
export type ItemId = string;
export type ListRevision = string;
export type SessionRevision = string;
declare const timelinePrefixRevisionBrand: unique symbol;
export type TimelinePrefixRevision = string & {
  readonly [timelinePrefixRevisionBrand]: true;
};

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  ordinal: number | null;
}

export interface AgentIdentity {
  taskName: string | null;
  nickname: string | null;
  role: string | null;
}

export interface SessionOrigin {
  sourceType: string;
  sourceInstanceId: string;
  agentName: string;
  agentVersion: string | null;
  formatVersion: string | null;
}

export interface SessionSummary {
  id: SessionId;
  origin: SessionOrigin;
  title: string;
  preview: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  parentId: SessionId | null;
  childIds: SessionId[];
  agent: AgentIdentity | null;
  messageCount: number;
  toolCount: number;
  warningCount: number;
}

export interface SessionDetail extends SessionSummary {
  sourceId: string | null;
  diagnostics: Diagnostic[];
  itemCount: number;
}

interface TimelineItemBase {
  id: ItemId;
  ordinal: number;
  timestamp: string | null;
}

export interface MessageItem extends TimelineItemBase {
  kind: "message";
  role: "user" | "assistant";
  phase: "commentary" | "final" | null;
  markdown: string;
}

export interface DirectiveItem extends TimelineItemBase {
  kind: "directive";
  summary: string;
  charCount: number;
  truncated: boolean;
  hasDetail: true;
}

interface ToolItemBase extends TimelineItemBase {
  kind: "tool";
  callId: string;
  toolName: string;
  preview: string | null;
  truncated: boolean;
  hasDetail: boolean;
}

export interface ToolCallItem extends ToolItemBase {
  stage: "call";
}

export interface ToolOutputItem extends ToolItemBase {
  stage: "output";
  status: "completed" | "failed";
}

export type ToolItem = ToolCallItem | ToolOutputItem;

export interface TokenUsageCounters {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface TokenItem extends TimelineItemBase {
  kind: "token";
  tokenUsage: {
    total: TokenUsageCounters | null;
    last: TokenUsageCounters | null;
  };
}

export interface InternalEventItem extends TimelineItemBase {
  kind: "internal";
  eventType: string;
  summary: string;
}

export type TimelineItem =
  | MessageItem
  | DirectiveItem
  | ToolItem
  | TokenItem
  | InternalEventItem;
