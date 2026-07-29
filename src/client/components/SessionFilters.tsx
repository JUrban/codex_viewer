import type { BrowserFilters } from "../state/use-session-browser";
import type { ProjectFacet } from "../../shared/api-contract";

interface SessionFiltersProps {
  filters: BrowserFilters;
  projects: ProjectFacet[];
  onChange: (filters: BrowserFilters) => void;
}

export function SessionFilters({ filters, projects, onChange }: SessionFiltersProps) {
  const patch = (value: Partial<BrowserFilters>) => onChange({ ...filters, ...value });

  return (
    <form className="filters" role="search" onSubmit={(event) => event.preventDefault()}>
      <label htmlFor="session-search">Find a session</label>
      <input
        id="session-search"
        type="search"
        value={filters.q}
        onChange={(event) => patch({ q: event.target.value })}
        placeholder="Title, project, or message"
      />
      <div className="filter-grid">
        <label>
          Project
          <select
            value={filters.project}
            onChange={(event) => patch({ project: event.target.value })}
          >
            <option value="">All projects</option>
            {projects.map(({ project, count }) => (
              <option value={project} key={project}>{project} ({count})</option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={filters.from}
            onChange={(event) => patch({ from: event.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={filters.to}
            onChange={(event) => patch({ to: event.target.value })}
          />
        </label>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={filters.archived}
          onChange={(event) => patch({ archived: event.target.checked })}
        />
        Archived only
      </label>
    </form>
  );
}
