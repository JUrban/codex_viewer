import { useEffect, useRef, useState } from "react";
import type { BrowserFilters } from "../state/use-session-filters";
import type { ProjectFacet } from "../../shared/api-contract";

interface SessionFiltersProps {
  filters: BrowserFilters;
  projects: ProjectFacet[];
  onChange: (filters: BrowserFilters) => void;
}

export function SessionFilters({ filters, projects, onChange }: SessionFiltersProps) {
  const [fromDraft, setFromDraft] = useState(filters.from);
  const [toDraft, setToDraft] = useState(filters.to);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const datePickerRef = useRef<HTMLDivElement>(null);
  const dateTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setFromDraft(filters.from);
    setToDraft(filters.to);
  }, [filters.from, filters.to]);
  useEffect(() => {
    if (!datePickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!datePickerRef.current?.contains(event.target as Node)) {
        setDatePickerOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDatePickerOpen(false);
      dateTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [datePickerOpen]);

  const patch = (value: Partial<BrowserFilters>) => onChange({ ...filters, ...value });
  const invalidDateRange = Boolean(fromDraft && toDraft && fromDraft > toDraft);
  const datesChanged = fromDraft !== filters.from || toDraft !== filters.to;
  const applyDates = () => {
    if (!datesChanged || invalidDateRange) return;
    onChange({ ...filters, from: fromDraft, to: toDraft });
    setDatePickerOpen(false);
  };

  return (
    <div className="filters">
      <select
        className="project-filter"
        aria-label="Project"
        value={filters.project}
        onChange={(event) => patch({ project: event.target.value })}
      >
        <option value="">All projects</option>
        {projects.map(({ project, count }) => (
          <option value={project} key={project}>{project} ({count})</option>
        ))}
      </select>
      <div className="date-grid">
        <div className="date-picker" ref={datePickerRef}>
          <button
            ref={dateTriggerRef}
            className="date-trigger"
            type="button"
            aria-expanded={datePickerOpen}
            aria-controls="date-range-popover"
            onClick={() => setDatePickerOpen((open) => !open)}
          >
            <span className="date-trigger-value">
              {dateRangeLabel(fromDraft, toDraft)}
            </span>
          </button>
          <div
            id="date-range-popover"
            className="date-popover"
            role="group"
            aria-label="Date range"
            hidden={!datePickerOpen}
          >
            <div className="date-fields">
              <label>
                <span>From</span>
                <input
                  type="date"
                  aria-label="From"
                  title="From"
                  value={fromDraft}
                  onChange={(event) => setFromDraft(event.target.value)}
                />
              </label>
              <label>
                <span>To</span>
                <input
                  type="date"
                  aria-label="To"
                  title="To"
                  value={toDraft}
                  min={fromDraft || undefined}
                  onChange={(event) => setToDraft(event.target.value)}
                />
              </label>
            </div>
            {invalidDateRange && (
              <p className="date-range-error" role="status">
                To must be on or after From
              </p>
            )}
          </div>
        </div>
        <button
          className="date-apply"
          type="button"
          disabled={!datesChanged || invalidDateRange}
          onClick={applyDates}
        >
          Set
        </button>
      </div>
      <fieldset
        className="filter-section archive-scope"
        aria-label="Session state"
        title="Session state"
      >
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
    </div>
  );
}

function dateRangeLabel(from: string, to: string): string {
  if (from && to) return `${from} → ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Until ${to}`;
  return "Date range";
}

const ARCHIVE_SCOPES = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
] as const;
