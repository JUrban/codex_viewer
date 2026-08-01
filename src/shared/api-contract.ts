import type {
  ItemId,
  ListRevision,
  SessionDetail,
  SessionId,
  SessionRevision,
  SessionSummary,
  TimelinePrefixRevision,
  TimelineItem,
} from "./domain.js";

export interface ApiWarning {
  code: string;
  message: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export type ArchiveScope = "active" | "archived" | "all";

export interface SessionListQuery {
  q?: string;
  project?: string;
  from?: string;
  to?: string;
  archiveScope?: ArchiveScope;
  offset?: number;
  limit?: number;
  listRevision?: ListRevision;
}

export interface SearchMatch {
  field: "title" | "cwd" | "message";
  excerpt: string;
}

export interface SessionListEntry {
  session: SessionSummary;
  matches: SearchMatch[];
}

export interface ProjectFacet {
  project: string;
  count: number;
}

export interface SessionListResponse {
  listRevision: ListRevision;
  sessions: SessionListEntry[];
  projects: ProjectFacet[];
  total: number;
  nextOffset: number | null;
  hasMore: boolean;
  partial: boolean;
  warnings: ApiWarning[];
}

export interface SessionReadCursor {
  sessionRevision: SessionRevision;
  throughOrdinal: number;
  timelinePrefixRevision: TimelinePrefixRevision;
}

export interface SessionReadContext {
  cursor: SessionReadCursor;
  session: SessionDetail;
  hasMore: boolean;
}

export interface SessionDetailQuery {
  cursor?: SessionReadCursor;
}

export interface SessionDetailResponse {
  context: SessionReadContext;
  interaction: InteractionResponse;
}

export interface ItemPageQuery {
  limit?: number;
  cursor: SessionReadCursor;
}

export interface ItemPageResponse {
  context: SessionReadContext;
  items: TimelineItem[];
  interaction: InteractionResponse;
}

export interface ToolDetailResponse {
  context: SessionReadContext;
  sessionId: SessionId;
  itemId: ItemId;
  input: string | null;
  output: string | null;
  truncated: boolean;
}

export interface ToolDetailQuery {
  cursor: SessionReadCursor;
}

export interface DirectiveDetailResponse {
  context: SessionReadContext;
  sessionId: SessionId;
  itemId: ItemId;
  text: string;
  truncated: boolean;
}

export interface DirectiveDetailQuery {
  cursor: SessionReadCursor;
}

export type InteractionState =
  | "unbound"
  | "disconnected"
  | "idle"
  | "running"
  | "awaiting_user_input";

export type InteractionResponse =
  | { supported: false }
  | {
      supported: true;
      state: InteractionState;
      activation: string;
      canSendMessage: boolean;
      canInterrupt: boolean;
      canSendEscape: boolean;
    };
