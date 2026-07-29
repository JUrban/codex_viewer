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
      <div className="date-grid">
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
      <label className="project-filter">
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
      <fieldset className="filter-section archive-scope">
        <legend>Session state</legend>
        <div className="archive-scope-options">
          {ARCHIVE_SCOPES.map(({ value, label }) => (
            <label key={value}>
              <input
                type="radio"
                name="archive-scope"
                value={value}
                checked={filters.archiveScope === value}
                onChange={() => patch({ archiveScope: value })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </form>
  );
}

const ARCHIVE_SCOPES = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
] as const;
