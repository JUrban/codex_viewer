export type SessionArchiveScope = "active" | "archived" | "all";

export interface SessionListCriteria {
  readonly project?: string;
  readonly from?: string;
  readonly to?: string;
  readonly archiveScope?: SessionArchiveScope;
  readonly limit?: number;
  readonly cursor?: string;
  readonly fresh?: boolean;
}

export interface ItemPageCriteria {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ToolDetailCriteria {
  readonly cursor: string;
}

export interface DirectiveDetailCriteria {
  readonly cursor: string;
}
