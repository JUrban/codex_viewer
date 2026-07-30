import type {
  CatalogGeneration,
  Diagnostic,
  ItemId,
  SessionDetail,
  SessionId,
  SessionSummary,
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

export interface StatusResponse {
  available: boolean;
  generation: CatalogGeneration;
  sessionCount: number;
  warningCount: number;
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
  generation?: CatalogGeneration;
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
  generation: CatalogGeneration;
  sessions: SessionListEntry[];
  projects: ProjectFacet[];
  total: number;
  nextOffset: number | null;
  hasMore: boolean;
  partial: boolean;
  warnings: ApiWarning[];
}

export interface SessionDetailResponse {
  generation: CatalogGeneration;
  session: SessionDetail;
}

export interface ItemPageQuery {
  afterOrdinal?: number;
  limit?: number;
  generation?: CatalogGeneration;
}

export interface ItemPageResponse {
  generation: CatalogGeneration;
  items: TimelineItem[];
  nextAfterOrdinal: number | null;
  hasMore: boolean;
  diagnostics: Diagnostic[];
}

export interface ToolDetailResponse {
  generation: CatalogGeneration;
  sessionId: SessionId;
  itemId: ItemId;
  input: string | null;
  output: string | null;
  truncated: boolean;
}

export interface ToolDetailQuery {
  generation: CatalogGeneration;
}

export interface DirectiveDetailResponse {
  generation: CatalogGeneration;
  sessionId: SessionId;
  itemId: ItemId;
  text: string;
  truncated: boolean;
}

export interface DirectiveDetailQuery {
  generation: CatalogGeneration;
}
