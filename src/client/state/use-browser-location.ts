import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TIMELINE_VISIBILITY,
  type TimelineVisibility,
  type TimelineVisibilityKey,
} from "./timeline-visibility";

export function useBrowserLocation() {
  const [visibility, setVisibilityState] = useState<TimelineVisibility>(readVisibility);

  const setVisibility = useCallback((key: TimelineVisibilityKey, visible: boolean) => {
    setVisibilityState((current) => {
      if (current[key] === visible) return current;
      const next = { ...current, [key]: visible };
      writeVisibility(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onPopState = () => setVisibilityState(readVisibility());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return { visibility, setVisibility };
}

function readVisibility(): TimelineVisibility {
  const shown = new Set(
    (new URLSearchParams(window.location.search).get("show") ?? "")
      .split(",")
      .filter(Boolean),
  );
  return {
    ...DEFAULT_TIMELINE_VISIBILITY,
    directive: shown.has("directive"),
    tools: shown.has("tool"),
    token: shown.has("token"),
    internal: shown.has("internal"),
  };
}

function writeVisibility(visibility: TimelineVisibility): void {
  const shown = VISIBILITY_URL_VALUES
    .filter(({ key }) => visibility[key])
    .map(({ value }) => value);
  const params = new URLSearchParams(window.location.search);
  if (shown.length === 0) params.delete("show");
  else params.set("show", shown.join(","));
  const query = params.toString();
  window.history.pushState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
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
