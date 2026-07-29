import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TIMELINE_VISIBILITY,
  type TimelineVisibility,
  type TimelineVisibilityKey,
} from "./timeline-visibility";
import type { ArchiveScope } from "../../shared/api-contract";

export interface BrowserFilters {
  q: string;
  project: string;
  from: string;
  to: string;
  archiveScope: ArchiveScope;
}

export interface BrowserLocation {
  filters: BrowserFilters;
  selectedId: string | null;
  visibility: TimelineVisibility;
}

export const EMPTY_FILTERS: BrowserFilters = {
  q: "",
  project: "",
  from: "",
  to: "",
  archiveScope: "active",
};

export function useBrowserLocation() {
  const [location, setLocation] = useState<BrowserLocation>(readUrl);
  const locationRef = useRef(location);
  locationRef.current = location;

  const commit = useCallback((next: BrowserLocation, replace = false) => {
    writeUrl(next, replace);
    setLocation(next);
  }, []);

  const setFilters = useCallback((filters: BrowserFilters) => {
    const next = { ...locationRef.current, filters };
    if (sameUrlFilters(locationRef.current.filters, filters)) {
      setLocation(next);
      return;
    }
    commit(next);
  }, [commit]);

  const selectSession = useCallback((selectedId: string | null) => {
    if (selectedId === locationRef.current.selectedId) return;
    commit({ ...locationRef.current, selectedId });
  }, [commit]);

  const setVisibility = useCallback((key: TimelineVisibilityKey, visible: boolean) => {
    if (visible === locationRef.current.visibility[key]) return;
    commit({
      ...locationRef.current,
      visibility: { ...locationRef.current.visibility, [key]: visible },
    });
  }, [commit]);

  const clearMissingSession = useCallback(() => {
    commit({ ...locationRef.current, selectedId: null }, true);
  }, [commit]);

  useEffect(() => {
    const onPopState = () => {
      setLocation(readUrl());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return {
    ...location,
    setFilters,
    selectSession,
    setVisibility,
    clearMissingSession,
  };
}

function readUrl(): BrowserLocation {
  const params = new URLSearchParams(window.location.search);
  const shown = new Set((params.get("show") ?? "").split(",").filter(Boolean));
  return {
    filters: {
      q: params.get("q") ?? "",
      project: params.get("project") ?? "",
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
      archiveScope: parseArchiveScope(params.get("archiveScope")),
    },
    selectedId: params.get("session"),
    visibility: {
      ...DEFAULT_TIMELINE_VISIBILITY,
      directive: shown.has("directive"),
      tools: shown.has("tool"),
      token: shown.has("token"),
      internal: shown.has("internal"),
    },
  };
}

function writeUrl(location: BrowserLocation, replace: boolean): void {
  const { filters, selectedId, visibility } = location;
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.project) params.set("project", filters.project);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.archiveScope !== "active") {
    params.set("archiveScope", filters.archiveScope);
  }
  if (selectedId) params.set("session", selectedId);
  const shown = VISIBILITY_URL_VALUES
    .filter(({ key }) => visibility[key])
    .map(({ value }) => value);
  const queryParts = [params.toString()];
  if (shown.length > 0) queryParts.push(`show=${shown.join(",")}`);
  const query = queryParts.filter(Boolean).join("&");
  const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
}

const VISIBILITY_URL_VALUES: ReadonlyArray<{
  key: TimelineVisibilityKey;
  value: string;
}> = [
  { key: "directive", value: "directive" },
  { key: "tools", value: "tool" },
  { key: "token", value: "token" },
  { key: "internal", value: "internal" },
];

function sameUrlFilters(left: BrowserFilters, right: BrowserFilters): boolean {
  return left.q === right.q &&
    left.project === right.project &&
    left.from === right.from &&
    left.to === right.to &&
    left.archiveScope === right.archiveScope;
}

function parseArchiveScope(value: string | null): ArchiveScope {
  return value === "archived" || value === "all" ? value : "active";
}
