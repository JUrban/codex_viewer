import { useCallback } from "react";
import { useBrowserLocation } from "./use-browser-location";
import {
  useSessionFilters,
  type BrowserFilters,
} from "./use-session-filters";
import { useSessionList } from "./use-session-list";
import { useSessionReader } from "./use-session-reader";

export type { BrowserFilters };

export function useSessionBrowser() {
  const filterState = useSessionFilters();
  const location = useBrowserLocation();
  const catalog = useSessionList(filterState.filters);
  const reader = useSessionReader(
    location.selectedId,
    location.clearMissingSession,
  );

  const refreshSessions = useCallback(async () => {
    const refreshed = await catalog.refresh();
    if (refreshed === null || location.selectedId === null) return;
    await reader.restartSession();
  }, [
    catalog.refresh,
    location.selectedId,
    reader.restartSession,
  ]);

  return {
    filters: {
      applied: filterState.filters,
      set: filterState.setFilters,
    },
    location: {
      selectedId: location.selectedId,
      selectSession: location.selectSession,
      visibility: location.visibility,
      setVisibility: location.setVisibility,
    },
    catalog,
    reader,
    refreshSessions,
  };
}
