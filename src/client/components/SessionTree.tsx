import type { SessionListEntry } from "../../shared/api-contract";

export interface SessionGroup {
  root: SessionListEntry;
  children: SessionGroup[];
  orphan: boolean;
}

export function groupSessions(entries: SessionListEntry[]): SessionGroup[] {
  const byId = new Map(entries.map((entry) => [entry.session.id, entry]));
  const children = new Map<string, SessionListEntry[]>();
  for (const entry of entries) {
    if (entry.session.parentId && byId.has(entry.session.parentId)) {
      const group = children.get(entry.session.parentId) ?? [];
      group.push(entry);
      children.set(entry.session.parentId, group);
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
      children: (children.get(root.session.id) ?? [])
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

export function SessionTree({ entries, selectedId, onSelect }: {
  entries: SessionListEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = groupSessions(entries);
  return (
    <nav aria-label="Sessions">
      <p className="section-label">Sessions · {entries.length}</p>
      <ul className="session-list">
        {groups.map((group) => <SessionBranch key={group.root.session.id} group={group}
          selectedId={selectedId} onSelect={onSelect} />)}
      </ul>
    </nav>
  );
}

function SessionBranch({ group, selectedId, onSelect, child = false }: {
  group: SessionGroup;
  selectedId: string | null;
  onSelect: (id: string) => void;
  child?: boolean;
}) {
  return <li>
    {group.orphan ? <p className="orphan-label">Parent unavailable</p> : null}
    <SessionButton entry={group.root} selected={selectedId === group.root.session.id}
      onSelect={onSelect} child={child} />
    {group.children.length ? <ul className="child-list">
      {group.children.map((nested) => <SessionBranch key={nested.root.session.id}
        group={nested} selectedId={selectedId} onSelect={onSelect} child />)}
    </ul> : null}
  </li>;
}

function SessionButton({ entry, selected, onSelect, child = false }: {
  entry: SessionListEntry;
  selected: boolean;
  onSelect: (id: string) => void;
  child?: boolean;
}) {
  const { session, matches } = entry;
  return (
    <button className={`session${selected ? " selected" : ""}${child ? " child" : ""}`}
      type="button" aria-current={selected ? "page" : undefined} onClick={() => onSelect(session.id)}>
      <span>{session.title}</span>
      <small>{session.cwd ?? "Project unavailable"} · {session.sourceState}</small>
      {matches[0] ? <small className="match">{matches[0].excerpt}</small> : null}
    </button>
  );
}
