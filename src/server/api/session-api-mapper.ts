import type {
  DirectiveDetailResponse,
  ItemPageResponse,
  SessionDetailResponse,
  SessionListResponse,
  StatusResponse,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type {
  Diagnostic,
  SessionDetail,
  SessionRevision,
  SessionSummary,
  TimelineItem,
} from "../../shared/domain.js";
import type {
  DomainDiagnostic,
  DomainDirectiveDetail,
  DomainSession,
  DomainTimelineRecord,
  DomainToolDetail,
} from "../domain/session-domain.js";
import type {
  ItemPageResult,
  SessionListResult,
} from "../repository/session-query-service.js";
import type { CatalogSnapshot } from "../repository/catalog-snapshot-store.js";

export class SessionApiMapper {
  status(snapshot: CatalogSnapshot): StatusResponse {
    return {
      available: snapshot.sessions.size > 0,
      catalogGeneration: snapshot.catalogGeneration,
      sessionCount: snapshot.sessions.size,
      warningCount: snapshot.warningCount,
    };
  }

  list(result: SessionListResult): SessionListResponse {
    return {
      catalogGeneration: result.catalogGeneration,
      sessions: result.sessions.map((entry) => ({
        session: this.summary(entry.session),
        matches: entry.matches.map((match) => ({ ...match })),
      })),
      projects: result.projects.map((facet) => ({ ...facet })),
      total: result.total,
      nextOffset: result.nextOffset,
      hasMore: result.hasMore,
      partial: result.partial,
      warnings: result.warnings.map((warning) => ({ ...warning })),
    };
  }

  detail(
    sessionRevision: SessionRevision,
    session: DomainSession,
  ): SessionDetailResponse {
    return { sessionRevision, session: this.sessionDetail(session) };
  }

  itemPage(result: ItemPageResult): ItemPageResponse {
    return {
      sessionRevision: result.sessionRevision,
      items: result.items.map((item) => this.timelineItem(item)),
      nextAfterOrdinal: result.nextAfterOrdinal,
      hasMore: result.hasMore,
      diagnostics: result.diagnostics.map((item) => this.diagnostic(item)),
    };
  }

  toolDetail(
    sessionRevision: SessionRevision,
    sessionId: string,
    itemId: string,
    detail: DomainToolDetail,
  ): ToolDetailResponse {
    return {
      sessionRevision,
      sessionId,
      itemId,
      input: detail.input,
      output: detail.output,
      truncated: detail.truncated,
    };
  }

  directiveDetail(
    sessionRevision: SessionRevision,
    sessionId: string,
    itemId: string,
    detail: DomainDirectiveDetail,
  ): DirectiveDetailResponse {
    return {
      sessionRevision,
      sessionId,
      itemId,
      text: detail.text,
      truncated: detail.truncated,
    };
  }

  summary(session: DomainSession): SessionSummary {
    return {
      id: session.id,
      origin: { ...session.origin },
      title: session.title,
      preview: session.preview,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archived: session.archived,
      parentId: session.parentId,
      childIds: [...session.childIds],
      agent: session.agent === null ? null : { ...session.agent },
      messageCount: session.messageCount,
      toolCount: session.toolCount,
      warningCount: session.warningCount,
    };
  }

  sessionDetail(session: DomainSession): SessionDetail {
    return {
      ...this.summary(session),
      sourceId: session.sourceId,
      diagnostics: session.diagnostics.map((item) => this.diagnostic(item)),
      itemCount: session.itemCount,
    };
  }

  timelineItem(item: DomainTimelineRecord): TimelineItem {
    if (item.kind !== "token") return { ...item };
    return {
      ...item,
      tokenUsage: {
        total: item.tokenUsage.total === null ? null : { ...item.tokenUsage.total },
        last: item.tokenUsage.last === null ? null : { ...item.tokenUsage.last },
      },
    };
  }

  diagnostic(item: DomainDiagnostic): Diagnostic {
    return { ...item };
  }
}
