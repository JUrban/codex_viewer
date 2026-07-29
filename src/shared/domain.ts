export type SessionId = string;
export type ItemId = string;
export type CatalogGeneration = number;

export type SourceState = "complete" | "partial" | "unavailable";
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  ordinal: number | null;
}

export interface SessionSummary {
  id: SessionId;
  title: string;
  preview: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  parentId: SessionId | null;
  childIds: SessionId[];
  sourceState: SourceState;
  messageCount: number;
  toolCount: number;
  warningCount: number;
}

export interface SessionDetail extends SessionSummary {
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

export interface ToolItem extends TimelineItemBase {
  kind: "tool";
  toolName: string;
  status: "pending" | "completed" | "failed" | "interrupted";
  preview: string | null;
  truncated: boolean;
  hasDetail: boolean;
}

export interface ReasoningUnavailableItem extends TimelineItemBase {
  kind: "reasoning-unavailable";
}

export interface InternalEventItem extends TimelineItemBase {
  kind: "internal";
  eventType: string;
  summary: string;
}

export type TimelineItem =
  | MessageItem
  | ToolItem
  | ReasoningUnavailableItem
  | InternalEventItem;
