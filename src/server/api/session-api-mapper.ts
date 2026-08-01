import type {
  DirectiveDetailResponse,
  ItemPageResponse,
  SessionReadContext,
  SessionDetailResponse,
  SessionListResponse,
  ToolDetailResponse,
} from "../../shared/api-contract.js";
import type {
  Diagnostic,
  SessionDetail,
  SessionSummary,
  TimelineItem,
} from "../../shared/domain.js";
import type {
  DomainDiagnostic,
  DomainSession,
  DomainTimelineRecord,
} from "../domain/session-domain.js";
import type {
  DirectiveDetailResult,
  ItemPageResult,
  SessionReadContextResult,
  SessionListResult,
  ToolDetailResult,
} from "../repository/session-query-service.js";

export class SessionApiMapper {
  list(result: SessionListResult): SessionListResponse {
    return {
      listRevision: result.listRevision,
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

  detail(result: SessionReadContextResult): SessionDetailResponse {
    return { context: this.readContext(result) };
  }

  itemPage(result: ItemPageResult): ItemPageResponse {
    return {
      context: this.readContext(result.context),
      items: result.items.map((item) => this.timelineItem(item)),
    };
  }

  readContext(result: SessionReadContextResult): SessionReadContext {
    return {
      cursor: {
        sessionRevision: result.sessionRevision,
        throughOrdinal: result.throughOrdinal,
        timelinePrefixRevision: result.timelinePrefixRevision,
      },
      session: this.sessionDetail(result.session),
      hasMore: result.hasMore,
    };
  }

  toolDetail(
    sessionId: string,
    itemId: string,
    result: ToolDetailResult,
  ): ToolDetailResponse {
    return {
      context: this.readContext(result.context),
      sessionId,
      itemId,
      input: result.detail.input,
      output: result.detail.output,
      truncated: result.detail.truncated,
    };
  }

  directiveDetail(
    sessionId: string,
    itemId: string,
    result: DirectiveDetailResult,
  ): DirectiveDetailResponse {
    return {
      context: this.readContext(result.context),
      sessionId,
      itemId,
      text: result.detail.text,
      truncated: result.detail.truncated,
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
    if (item.kind === "user_input") {
      if (item.stage === "request") {
        return {
          ...item,
          questions: item.questions.map((question) => ({
            ...question,
            options: question.options.map((option) => ({ ...option })),
          })),
        };
      }
      return item.outcome === "answered"
        ? {
            ...item,
            answers: item.answers.map((answer) => ({
              ...answer,
              answers: [...answer.answers],
            })),
          }
        : { ...item };
    }
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
