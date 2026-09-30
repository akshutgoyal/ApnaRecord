import { useCallback, useEffect, useRef, useState } from 'react';
import { chainEvents } from '../services/api';

/**
 * The event log as a paged, server-filtered feed.
 *
 * Filtering and paging happen on the server because the log is the one dataset
 * that grows without bound. Doing it in the browser means eventually downloading
 * every event in order to display ten of them.
 *
 * The request is debounced on the search term so typing does not fire a request
 * per keystroke — the search runs against the whole log set server-side, and
 * hammering it while someone types "Access" is four wasted round trips.
 */
export function useEventFeed({ pageSize = 10, name = '', actor = '', search = '', enabled = true } = {}) {
  const [state, setState] = useState({ events: [], total: 0, scanned: 0, loading: true, error: null });
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Any filter change returns to page one. Landing on page 3 of a two-row result
  // is the most common table bug there is.
  useEffect(() => {
    setPage(1);
  }, [name, actor, debouncedSearch, pageSize]);

  const load = useCallback(async () => {
    if (!enabled) {
      setState({ events: [], total: 0, scanned: 0, loading: false, error: null });
      return;
    }
    const id = ++requestId.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const payload = await chainEvents({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        name: name || undefined,
        actor: actor || undefined,
        search: debouncedSearch || undefined,
      });
      // Ignore a response that has been superseded — otherwise a slow request for
      // page 1 can land after a fast one for page 2 and overwrite it.
      if (id !== requestId.current) return;
      setState({
        events: payload.events || [],
        total: payload.total ?? 0,
        scanned: payload.scanned ?? 0,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (id !== requestId.current) return;
      setState({ events: [], total: 0, scanned: 0, loading: false, error: error.message });
    }
  }, [enabled, page, pageSize, name, actor, debouncedSearch]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(state.total / pageSize));

  return {
    ...state,
    page,
    setPage,
    pageSize,
    totalPages,
    reload: load,
  };
}
