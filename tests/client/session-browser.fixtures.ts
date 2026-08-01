import { vi } from "vitest";
import type {
  ItemPageResponse,
  SessionListEntry,
  SessionReadContext,
} from "../../src/shared/api-contract";
import type {
  DirectiveItem as Directive,
  SessionSummary,
  TimelinePrefixRevision,
  ToolItem as Tool,
} from "../../src/shared/domain";

export const SESSION_ID = "abcdefghijklmnopqrstuvwx";
export const CHILD_ID = "zyxwvutsrqponmlkjihgfedc";
export const OTHER_ID = "otherabcdefghijklmnopqrs";
export const SESSION_REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const NEXT_SESSION_REVISION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const LIST_REVISION = "llllllllllllllllllllllllllllllll";
export const NEXT_LIST_REVISION = "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";
export const TIMELINE_PREFIX_REVISION =
  "pppppppppppppppppppppppppppppppp" as TimelinePrefixRevision;
export const NEXT_TIMELINE_PREFIX_REVISION =
  "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" as TimelinePrefixRevision;
export const EMPTY_TIMELINE_PREFIX_REVISION =
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as TimelinePrefixRevision;

export const baseSession: SessionSummary = {
  id: SESSION_ID, title: "Reader work", preview: "preview", cwd: "/project/reader",
  origin: {
    sourceType: "codex-jsonl",
    sourceInstanceId: "source-instance",
    agentName: "Codex",
    agentVersion: null,
    formatVersion: null,
  },
  createdAt: "2026-07-28T10:00:00Z", updatedAt: "2026-07-28T11:00:00Z",
  archived: false, parentId: null, childIds: [],
  agent: null,
  messageCount: 2, toolCount: 1, warningCount: 0,
};

export const listBody = {
  listRevision: LIST_REVISION,
  sessions: [{ session: baseSession, matches: [] }],
  projects: [{ project: "/project/reader", count: 1 }],
  total: 1, nextOffset: null, hasMore: false,
  partial: false, warnings: [],
};

export const sessionDetail = {
  ...baseSession,
  sourceId: "original-session-id",
  diagnostics: [],
  itemCount: 3,
};

export function readContext(
  sessionRevision = SESSION_REVISION,
  throughOrdinal = 2,
  hasMore = true,
): SessionReadContext {
  return {
    cursor: {
      sessionRevision,
      throughOrdinal,
      timelinePrefixRevision: throughOrdinal === 0
        ? EMPTY_TIMELINE_PREFIX_REVISION
        : TIMELINE_PREFIX_REVISION,
    },
    session: sessionDetail,
    hasMore,
  };
}

export const detailBody = {
  context: readContext(SESSION_REVISION, 0, true),
};

export const toolItem: Tool = {
  kind: "tool", stage: "output", id: "tool-2", ordinal: 2, timestamp: null,
  callId: "call-reader", toolName: "exec",
  status: "completed", preview: "inspect", truncated: false, hasDetail: true,
};

export const directiveItem: Directive = {
  kind: "directive",
  id: "directive-4",
  ordinal: 4,
  timestamp: null,
  summary: "AGENTS.md instructions",
  charCount: 1_892,
  truncated: false,
  hasDetail: true,
};

export const firstPage: ItemPageResponse = {
  context: readContext(),
  items: [
    { kind: "message", id: "message-1", ordinal: 1, timestamp: null, role: "user", phase: null, markdown: "Hello" },
    toolItem,
  ],
};

export function standardFetch(detail: unknown = detailBody) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/items")) {
      return Promise.resolve(json({
        ...firstPage,
        context: { ...firstPage.context, hasMore: false },
      }));
    }
    if (url.endsWith(SESSION_ID)) return Promise.resolve(json(detail));
    return Promise.resolve(json(listBody));
  });
}

export function entry(session: SessionSummary): SessionListEntry {
  return { session, matches: [] };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
