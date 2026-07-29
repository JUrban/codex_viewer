import { useCallback } from "react";
import {
  EMPTY_FILTERS,
  useBrowserLocation,
  type BrowserFilters,
} from "./use-browser-location";
import { useSessionList } from "./use-session-list";
import { useSessionReader } from "./use-session-reader";

export type { BrowserFilters };
export { EMPTY_FILTERS };

export function useSessionBrowser() {
  const location = useBrowserLocation();
  const list = useSessionList(location.filters);
  const reader = useSessionReader(
    location.selectedId,
    location.clearMissingSession,
  );

  const refreshSessions = useCallback(async () => {
    const refreshed = await list.refresh();
    if (refreshed === null) return;
    const result = location.selectedId === null
      ? "loaded"
      : await reader.restartSession();
    if (result === "missing") {
      list.setRefreshMessage(
        "Sessions refreshed · the selected session is no longer available",
      );
    } else if (result === "loaded") {
      list.setRefreshMessage(`Sessions refreshed · ${refreshed.total} available`);
    }
  }, [list.refresh, list.setRefreshMessage, location.selectedId, reader.restartSession]);

  return {
    filters: location.filters,
    setFilters: location.setFilters,
    selectedId: location.selectedId,
    selectSession: location.selectSession,
    visibility: location.visibility,
    setVisibility: location.setVisibility,
    list: list.list,
    detail: reader.detail,
    page: reader.page,
    items: reader.items,
    listLoading: list.listLoading,
    readerLoading: reader.readerLoading,
    refreshing: list.refreshing,
    refreshError: list.refreshError,
    refreshMessage: list.refreshMessage,
    listError: list.listError,
    readerError: reader.readerError,
    clearListError: list.clearListError,
    clearReaderError: reader.clearReaderError,
    loadMore: reader.loadMore,
    loadMoreSessions: list.loadMoreSessions,
    restartSession: reader.restartSession,
    refreshSessions,
  };
}
