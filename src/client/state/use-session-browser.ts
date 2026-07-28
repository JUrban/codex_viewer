import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ItemPageResponse,
  SessionDetailResponse,
  SessionListQuery,
  SessionListResponse,
} from "../../shared/api-contract";
import type { TimelineItem } from "../../shared/domain";
import { api, ApiClientError } from "../api/client";

export interface BrowserFilters {
  q: string;
  project: string;
  from: string;
  to: string;
  archived: boolean;
}

const EMPTY_FILTERS: BrowserFilters = {
  q: "",
  project: "",
  from: "",
  to: "",
  archived: false,
};

function listQuery(filters: BrowserFilters, q: string): SessionListQuery {
  return {
    q: q || undefined,
    project: filters.project || undefined,
    from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : undefined,
    archived: filters.archived || undefined,
    limit: 200,
  };
}

function readUrl(): { filters: BrowserFilters; selectedId: string | null; internal: boolean } {
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

function writeUrl(filters: BrowserFilters, selectedId: string | null, internal: boolean): void {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.project) params.set("project", filters.project);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.archived) params.set("archived", "true");
  if (selectedId) params.set("session", selectedId);
  if (internal) params.set("internal", "true");
  const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
  window.history.pushState(null, "", next);
}

export function useSessionBrowser() {
  const initial = useRef(readUrl()).current;
  const [filters, setFiltersState] = useState(initial.filters);
  const [debouncedQuery, setDebouncedQuery] = useState(initial.filters.q);
  const [selectedId, setSelectedIdState] = useState<string | null>(initial.selectedId);
  const [internal, setInternalState] = useState(initial.internal);
  const [list, setList] = useState<SessionListResponse | null>(null);
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [page, setPage] = useState<ItemPageResponse | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [readerLoading, setReaderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigationAbort = useRef<AbortController | null>(null);
  const listPageAbort = useRef<AbortController | null>(null);
  const listSequence = useRef(0);
  const loadSequence = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(filters.q), 250);
    return () => window.clearTimeout(timer);
  }, [filters.q]);

  const updateLocation = useCallback(
    (nextFilters: BrowserFilters, nextSelected: string | null, nextInternal: boolean) => {
      writeUrl(nextFilters, nextSelected, nextInternal);
    },
    [],
  );

  const setFilters = useCallback((next: BrowserFilters) => {
    setFiltersState(next);
    updateLocation(next, selectedId, internal);
  }, [internal, selectedId, updateLocation]);

  const selectSession = useCallback((id: string | null) => {
    setSelectedIdState(id);
    updateLocation(filters, id, internal);
  }, [filters, internal, updateLocation]);

  const setInternal = useCallback((value: boolean) => {
    setInternalState(value);
    updateLocation(filters, selectedId, value);
  }, [filters, selectedId, updateLocation]);

  useEffect(() => {
    const onPopState = () => {
      const next = readUrl();
      setFiltersState(next.filters);
      setDebouncedQuery(next.filters.q);
      setSelectedIdState(next.selectedId);
      setInternalState(next.internal);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    listPageAbort.current?.abort();
    const controller = new AbortController();
    const sequence = ++listSequence.current;
    setListLoading(true);
    const query = listQuery(filters, debouncedQuery);
    void api.sessions(query, controller.signal).then((response) => {
      if (sequence !== listSequence.current) return;
      setList(response);
      setError(null);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && sequence === listSequence.current) {
        setError(messageFor(reason));
      }
    }).finally(() => {
      if (!controller.signal.aborted && sequence === listSequence.current) {
        setListLoading(false);
      }
    });
    return () => controller.abort();
  }, [debouncedQuery, filters.archived, filters.from, filters.project, filters.to]);

  const loadMoreSessions = useCallback(async () => {
    if (!list?.hasMore || list.nextOffset === null) return;
    listPageAbort.current?.abort();
    const controller = new AbortController();
    listPageAbort.current = controller;
    const sequence = listSequence.current;
    setListLoading(true);
    try {
      const next = await api.sessions({
        ...listQuery(filters, debouncedQuery),
        offset: list.nextOffset,
        generation: list.generation,
      }, controller.signal);
      if (sequence !== listSequence.current) return;
      setList((current) => current?.generation === next.generation
        ? {
            ...next,
            sessions: [
              ...current.sessions,
              ...next.sessions.filter((entry) =>
                !current.sessions.some((existing) => existing.session.id === entry.session.id)),
            ],
          }
        : next);
      setError(null);
    } catch (reason) {
      if (controller.signal.aborted || sequence !== listSequence.current) return;
      if (reason instanceof ApiClientError && reason.code === "stale_generation") {
        setList(await api.sessions(listQuery(filters, debouncedQuery), controller.signal));
      } else {
        setError(messageFor(reason));
      }
    } finally {
      if (!controller.signal.aborted && sequence === listSequence.current) {
        setListLoading(false);
      }
    }
  }, [debouncedQuery, filters, list]);

  const loadSession = useCallback(async (id: string, quiet = false) => {
    navigationAbort.current?.abort();
    const controller = new AbortController();
    navigationAbort.current = controller;
    const sequence = ++loadSequence.current;
    if (!quiet) setReaderLoading(true);
    try {
      const nextDetail = await api.session(id, controller.signal);
      let nextPage: ItemPageResponse;
      try {
        nextPage = await api.items(id, {
          generation: nextDetail.generation,
          limit: 50,
          view: internal ? "internal" : "conversation",
        }, controller.signal);
      } catch (reason) {
        if (!(reason instanceof ApiClientError) || reason.code !== "stale_generation") throw reason;
        const restartedDetail = await api.session(id, controller.signal);
        nextPage = await api.items(id, {
          generation: restartedDetail.generation,
          limit: 50,
          view: internal ? "internal" : "conversation",
        }, controller.signal);
        if (sequence === loadSequence.current) setDetail(restartedDetail);
      }
      if (sequence !== loadSequence.current) return;
      setDetail((current) => current?.generation === nextPage.generation ? current : nextDetail);
      setPage(nextPage);
      setItems(nextPage.items);
      setError(null);
    } catch (reason) {
      if (!controller.signal.aborted && sequence === loadSequence.current) setError(messageFor(reason));
    } finally {
      if (!controller.signal.aborted && sequence === loadSequence.current) setReaderLoading(false);
    }
  }, [internal]);

  useEffect(() => {
    if (!selectedId) {
      navigationAbort.current?.abort();
      setDetail(null);
      setPage(null);
      setItems([]);
      return;
    }
    void loadSession(selectedId);
    return () => navigationAbort.current?.abort();
  }, [loadSession, selectedId]);

  useEffect(() => {
    if (!selectedId || detail?.session.sourceState !== "live") return;
    let timer: number | undefined;
    const schedule = () => {
      if (!document.hidden) timer = window.setTimeout(async () => {
        await loadSession(selectedId, true);
        schedule();
      }, 8_000);
    };
    const onVisibility = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!document.hidden) schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [detail?.session.sourceState, loadSession, selectedId]);

  const loadMore = useCallback(async () => {
    if (!selectedId || !page?.hasMore || page.nextAfterOrdinal === null) return;
    setReaderLoading(true);
    try {
      const next = await api.items(selectedId, {
        afterOrdinal: page.nextAfterOrdinal,
        generation: page.generation,
        limit: 50,
        view: internal ? "internal" : "conversation",
      });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...next.items.filter((item) => !seen.has(item.id))];
      });
      setPage(next);
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.code === "stale_generation") {
        await loadSession(selectedId);
      } else {
        setError(messageFor(reason));
      }
    } finally {
      setReaderLoading(false);
    }
  }, [internal, loadSession, page, selectedId]);

  return {
    filters, setFilters, selectedId, selectSession, internal, setInternal,
    list, detail, page, items, listLoading, readerLoading, error,
    clearError: () => setError(null), loadMore, loadMoreSessions,
    restartSession: () => selectedId ? loadSession(selectedId) : Promise.resolve(),
  };
}

function messageFor(reason: unknown): string {
  if (reason instanceof ApiClientError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return "The local session reader could not complete the request.";
}

export { EMPTY_FILTERS };
