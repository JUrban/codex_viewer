import { useMemo, useState } from "react";
import type { SessionListEntry } from "../../shared/api-contract";

export interface SessionGroup {
  root: SessionListEntry;
  children: SessionGroup[];
  orphan: boolean;
}

interface ExpansionOverrides {
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
}

export function groupSessions(entries: SessionListEntry[]): SessionGroup[] {
  const byId = new Map(entries.map((entry) => [entry.session.id, entry]));
  const childrenByParent = new Map<string, SessionListEntry[]>();

  for (const entry of entries) {
    if (entry.session.parentId && byId.has(entry.session.parentId)) {
      const siblings = childrenByParent.get(entry.session.parentId) ?? [];
      siblings.push(entry);
      childrenByParent.set(entry.session.parentId, siblings);
    }
  }

  const visited = new Set<string>();
  const build = (
    root: SessionListEntry,
    orphan: boolean,
    ancestors: ReadonlySet<string>,
  ): SessionGroup => {
    visited.add(root.session.id);
    const lineage = new Set(ancestors).add(root.session.id);
    return {
      root,
      orphan,
      children: (childrenByParent.get(root.session.id) ?? [])
        .filter((child) => !lineage.has(child.session.id))
        .map((child) => build(child, false, lineage)),
    };
  };

  const groups = entries
    .filter((entry) => !entry.session.parentId || !byId.has(entry.session.parentId))
    .map((root) => build(
      root,
      Boolean(root.session.parentId && !byId.has(root.session.parentId)),
      new Set(),
    ));

  for (const entry of entries) {
    if (!visited.has(entry.session.id)) groups.push(build(entry, true, new Set()));
  }

  return groups;
}

interface SessionTreeProps {
  entries: SessionListEntry[];
  revealMatches?: boolean;
}

export function SessionTree({
  entries,
  revealMatches = false,
}: SessionTreeProps) {
  const groups = useMemo(() => groupSessions(entries), [entries]);
  const [expansion, setExpansion] = useState<ExpansionOverrides>(() => ({
    expanded: new Set(),
    collapsed: new Set(),
  }));

  const onToggle = (id: string, open: boolean) => {
    setExpansion((current) => {
      const expanded = new Set(current.expanded);
      const collapsed = new Set(current.collapsed);
      updateMembership(expanded, id, !open);
      updateMembership(collapsed, id, open);
      return { expanded, collapsed };
    });
  };

  return (
    <nav aria-label="Sessions">
      <ul className="session-list">
        {groups.map((group) => (
          <SessionBranch
            key={group.root.session.id}
            group={group}
            expanded={expansion.expanded}
            collapsed={expansion.collapsed}
            revealMatches={revealMatches}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </nav>
  );
}

interface SessionBranchProps {
  group: SessionGroup;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  revealMatches: boolean;
  onToggle: (id: string, open: boolean) => void;
  child?: boolean;
}

function SessionBranch({
  group,
  expanded,
  collapsed,
  revealMatches,
  onToggle,
  child = false,
}: SessionBranchProps) {
  const { id, title } = group.root.session;
  const hasChildren = group.children.length > 0;
  const open = hasChildren && !collapsed.has(id) &&
    (expanded.has(id) || revealMatches);
  const childListId = `session-children-${id.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;

  return (
    <li>
      {group.orphan ? <p className="orphan-label">Parent unavailable</p> : null}
      <div className="session-row">
        {hasChildren
          ? (
              <button
                className={`session-disclosure${open ? " open" : ""}`}
                type="button"
                aria-expanded={open}
                aria-controls={childListId}
                aria-label={`${open ? "Collapse" : "Expand"} ${group.children.length} child sessions under ${title}`}
                onClick={() => onToggle(id, open)}
              >
                <span className="disclosure-mark" aria-hidden="true">›</span>
                <span className="child-count" aria-hidden="true">{group.children.length}</span>
              </button>
            )
          : <span className="session-disclosure-spacer" aria-hidden="true" />}
        <SessionButton
          entry={group.root}
          child={child}
        />
      </div>
      {open
        ? (
            <ul className="child-list" id={childListId}>
              {group.children.map((nested) => (
                <SessionBranch
                  key={nested.root.session.id}
                  group={nested}
                  expanded={expanded}
                  collapsed={collapsed}
                  revealMatches={revealMatches}
                  onToggle={onToggle}
                  child
                />
              ))}
            </ul>
          )
        : null}
    </li>
  );
}

interface SessionButtonProps {
  entry: SessionListEntry;
  child?: boolean;
}

function SessionButton({ entry, child = false }: SessionButtonProps) {
  const { session, matches } = entry;
  const taskName = child ? session.agent?.taskName ?? null : null;
  const displayTitle = taskName ?? session.title;
  const showOriginalTitle = taskName !== null && taskName !== session.title;
  const agentLabels = child
    ? [...new Set(
        [session.agent?.role, session.agent?.nickname]
          .filter((value): value is string => value !== null && value !== undefined),
      )]
    : [];

  return (
    <a
      className={`session${child ? " child" : ""}`}
      href={`/sessions/${encodeURIComponent(session.id)}`}
    >
      <span className={taskName === null ? "session-title" : "session-title task-name"}>
        {displayTitle}
      </span>
      {session.archived
        ? <span className="archive-label">Archived</span>
        : null}
      <span className="source-label">{session.origin.agentName}</span>
      {showOriginalTitle ? <small className="session-subtitle">{session.title}</small> : null}
      {child && agentLabels.length === 0
        ? null
        : (
            <small className="session-meta-line">
              {child
                ? agentLabels.map((label) => (
                    <span className="agent-label" key={label}>{label}</span>
                  ))
                : session.cwd ?? "Project unavailable"}
            </small>
          )}
      {matches[0] ? <small className="match">{matches[0].excerpt}</small> : null}
    </a>
  );
}

function updateMembership(values: Set<string>, value: string, included: boolean): void {
  if (included) values.add(value);
  else values.delete(value);
}
