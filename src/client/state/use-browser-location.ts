import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TIMELINE_VISIBILITY,
  type TimelineVisibility,
  type TimelineVisibilityKey,
} from "./timeline-visibility";
export interface BrowserLocation {
  selectedId: string | null;
  visibility: TimelineVisibility;
}

export function useBrowserLocation() {
  const [location, setLocation] = useState<BrowserLocation>(readUrl);
  const locationRef = useRef(location);
  locationRef.current = location;

  const commit = useCallback((next: BrowserLocation, replace = false) => {
    writeUrl(next, replace);
    setLocation(next);
  }, []);

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
    selectSession,
    setVisibility,
    clearMissingSession,
  };
}

function readUrl(): BrowserLocation {
  const params = new URLSearchParams(window.location.search);
  const shown = new Set((params.get("show") ?? "").split(",").filter(Boolean));
  const location = {
    selectedId: params.get("session"),
    visibility: {
      ...DEFAULT_TIMELINE_VISIBILITY,
      directive: shown.has("directive"),
      tools: shown.has("tool"),
      token: shown.has("token"),
      internal: shown.has("internal"),
    },
  };
  normalizeUrl(location);
  return location;
}

function writeUrl(location: BrowserLocation, replace: boolean): void {
  const next = locationUrl(location);
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
}

function normalizeUrl(location: BrowserLocation): void {
  const canonical = locationUrl(location);
  const current = `${window.location.pathname}${window.location.search}`;
  if (canonical !== current) window.history.replaceState(null, "", canonical);
}

function locationUrl(location: BrowserLocation): string {
  const { selectedId, visibility } = location;
  const params = new URLSearchParams();
  if (selectedId) params.set("session", selectedId);
  const shown = VISIBILITY_URL_VALUES
    .filter(({ key }) => visibility[key])
    .map(({ value }) => value);
  const queryParts = [params.toString()];
  if (shown.length > 0) queryParts.push(`show=${shown.join(",")}`);
  const query = queryParts.filter(Boolean).join("&");
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
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
