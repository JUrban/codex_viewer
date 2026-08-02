import type {
  ItemId,
  SessionDetail,
  SessionSummary,
  TimelineItem,
} from "./domain.js";

declare const listCursorBrand: unique symbol;
export type ListCursor = string & { readonly [listCursorBrand]: true };
declare const timelineCursorBrand: unique symbol;
export type TimelineCursor = string & { readonly [timelineCursorBrand]: true };

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
  limit?: number;
  cursor?: ListCursor;
  fresh?: boolean;
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
  sessions: SessionListEntry[];
  projects: ProjectFacet[];
  total: number;
  nextCursor: ListCursor | null;
  partial: boolean;
  warnings: ApiWarning[];
}

export interface SessionDetailResponse {
  session: SessionDetail;
  interaction: InteractionResponse;
}

export interface ItemPageQuery {
  limit?: number;
  cursor?: TimelineCursor;
}

export interface ItemPageResponse {
  session: SessionDetail;
  cursor: TimelineCursor;
  hasMore: boolean;
  items: TimelineItem[];
  interaction: InteractionResponse;
}

export interface ToolDetailResponse {
  itemId: ItemId;
  input: string | null;
  output: string | null;
  truncated: boolean;
}

export interface ToolDetailQuery {
  cursor: TimelineCursor;
}

export interface DirectiveDetailResponse {
  itemId: ItemId;
  text: string;
  truncated: boolean;
}

export interface DirectiveDetailQuery {
  cursor: TimelineCursor;
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
