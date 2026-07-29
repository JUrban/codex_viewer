import { useCallback, useEffect, useRef, useState } from "react";

export interface BrowserFilters {
  q: string;
  project: string;
  from: string;
  to: string;
  archived: boolean;
}

export interface BrowserLocation {
  filters: BrowserFilters;
  selectedId: string | null;
  internal: boolean;
}

export const EMPTY_FILTERS: BrowserFilters = {
  q: "",
  project: "",
  from: "",
  to: "",
  archived: false,
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
    commit({ ...locationRef.current, filters });
  }, [commit]);

  const selectSession = useCallback((selectedId: string | null) => {
    if (selectedId === locationRef.current.selectedId) return;
    commit({ ...locationRef.current, selectedId });
  }, [commit]);

  const setInternal = useCallback((internal: boolean) => {
    if (internal === locationRef.current.internal) return;
    commit({ ...locationRef.current, internal });
  }, [commit]);

  const clearMissingSession = useCallback(() => {
    commit({ ...locationRef.current, selectedId: null }, true);
  }, [commit]);

  useEffect(() => {
    const onPopState = () => setLocation(readUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return {
    ...location,
    setFilters,
    selectSession,
    setInternal,
    clearMissingSession,
  };
}

function readUrl(): BrowserLocation {
  const params = new URLSearchParams(window.location.search);
  return {
    filters: {
      q: params.get("q") ?? "",
      project: params.get("project") ?? "",
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
      archived: params.get("archived") === "true",
    },
    selectedId: params.get("session"),
    internal: params.get("internal") === "true",
  };
}

function writeUrl(location: BrowserLocation, replace: boolean): void {
  const { filters, selectedId, internal } = location;
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.project) params.set("project", filters.project);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.archived) params.set("archived", "true");
  if (selectedId) params.set("session", selectedId);
  if (internal) params.set("internal", "true");
  const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
}
