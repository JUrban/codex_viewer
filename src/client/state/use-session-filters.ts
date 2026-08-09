import { useCallback, useState } from "react";
import type { ArchiveScope } from "../../shared/api-contract";

const STORAGE_KEY = "codex-sessions-reader.filters.v1";

export interface BrowserFilters {
  project: string;
  from: string;
  to: string;
  archiveScope: ArchiveScope;
}

const DEFAULT_FILTERS: BrowserFilters = {
  project: "",
  from: "",
  to: "",
  archiveScope: "active",
};

interface StoredFilters {
  project: string;
  from: string;
  to: string;
  state: ArchiveScope;
}

export function useSessionFilters() {
  const [filters, setFiltersState] = useState<BrowserFilters>(readFilters);

  const setFilters = useCallback((next: BrowserFilters) => {
    const normalized = normalizeFilters(next);
    setFiltersState((current) => sameFilters(current, normalized) ? current : normalized);
    writeFilters(normalized);
  }, []);

  return { filters, setFilters };
}

function readFilters(): BrowserFilters {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null");
    if (!isStoredFilters(value)) return DEFAULT_FILTERS;
    return normalizeFilters({
      project: value.project,
      from: value.from,
      to: value.to,
      archiveScope: value.state,
    });
  } catch {
    return DEFAULT_FILTERS;
  }
}

function writeFilters(filters: BrowserFilters): void {
  const stored: StoredFilters = {
    project: filters.project,
    from: filters.from,
    to: filters.to,
    state: filters.archiveScope,
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage can be unavailable in privacy modes; filtering still works in memory.
  }
}

function normalizeFilters(filters: BrowserFilters): BrowserFilters {
  const from = validDate(filters.from) ? filters.from : "";
  const to = validDate(filters.to) ? filters.to : "";
  return {
    project: filters.project,
    from: from && to && from > to ? "" : from,
    to,
    archiveScope: isArchiveScope(filters.archiveScope) ? filters.archiveScope : "active",
  };
}

function isStoredFilters(value: unknown): value is StoredFilters {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 4 &&
    typeof candidate.project === "string" &&
    typeof candidate.from === "string" &&
    typeof candidate.to === "string" &&
    isArchiveScope(candidate.state) &&
    (!candidate.from || validDate(candidate.from)) &&
    (!candidate.to || validDate(candidate.to)) &&
    (!candidate.from || !candidate.to || candidate.from <= candidate.to);
}

function isArchiveScope(value: unknown): value is ArchiveScope {
  return value === "active" || value === "archived" || value === "all";
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value;
}

function sameFilters(left: BrowserFilters, right: BrowserFilters): boolean {
  return left.project === right.project &&
    left.from === right.from &&
    left.to === right.to &&
    left.archiveScope === right.archiveScope;
}
