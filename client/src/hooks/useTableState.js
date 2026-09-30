import { useCallback, useMemo, useState } from 'react';

/**
 * Search, filter, sort and paginate — in one place, because every table needs the
 * same four things and doing them ad hoc is how tables end up behaving
 * differently from each other.
 *
 * Two rules worth stating:
 *
 *   - Filtering resets the page. Landing on page 3 of a four-row result is the
 *     single most common table bug there is.
 *   - `isFiltered` is exposed so a table can distinguish "nothing exists yet" from
 *     "nothing matched", which are different sentences and must not share copy.
 *
 * @param {object}   options
 * @param {object[]} options.rows          The full dataset.
 * @param {string[]} options.searchFields  Fields the free-text query matches.
 * @param {object}   options.initialFilters
 * @param {object}   options.initialSort   { key, dir: 'asc' | 'desc' }
 * @param {number}   options.pageSize
 */
export function useTableState({
  rows = [],
  searchFields = [],
  initialFilters = {},
  initialSort = null,
  pageSize: initialPageSize = 10,
  sorters = {},
} = {}) {
  const [query, setQueryRaw] = useState('');
  const [filters, setFilters] = useState(initialFilters);
  const [sort, setSort] = useState(initialSort);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const setQuery = useCallback((value) => {
    setQueryRaw(value);
    setPage(1);
  }, []);

  const setFilter = useCallback((key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(initialFilters);
    setQueryRaw('');
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changePageSize = useCallback((size) => {
    setPageSize(size);
    setPage(1);
  }, []);

  const toggleSort = useCallback(
    (key) => {
      setSort((current) => {
        // asc -> desc -> off. A third press clearing the sort matters: without it
        // there is no way back to the server's own ordering.
        if (!current || current.key !== key) return { key, dir: 'asc' };
        if (current.dir === 'asc') return { key, dir: 'desc' };
        return null;
      });
      setPage(1);
    },
    []
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return rows.filter((row) => {
      const matchesQuery =
        !needle ||
        searchFields.some((field) => {
          const value = field.split('.').reduce((acc, part) => acc?.[part], row);
          return String(value ?? '').toLowerCase().includes(needle);
        });

      if (!matchesQuery) return false;

      return Object.entries(filters).every(([key, wanted]) => {
        if (wanted === undefined || wanted === null || wanted === '' || wanted === 'all') return true;
        const actual = row[key];
        if (Array.isArray(wanted)) return wanted.includes(actual);
        if (typeof wanted === 'function') return wanted(row);
        return actual === wanted;
      });
    });
  }, [rows, query, searchFields, filters]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const getter = sorters[sort.key] || ((row) => row[sort.key]);
    const direction = sort.dir === 'desc' ? -1 : 1;

    // Copy first: Array.prototype.sort mutates, and mutating a memoised array is
    // how a table ends up reordering its own source data.
    return [...filtered].sort((a, b) => {
      const left = getter(a);
      const right = getter(b);
      if (left === right) return 0;
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction;
      return String(left).localeCompare(String(right), undefined, { numeric: true }) * direction;
    });
  }, [filtered, sort, sorters]);

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sorted, safePage, pageSize]
  );

  const activeFilterCount = Object.entries(filters).filter(
    ([, value]) => value !== undefined && value !== null && value !== '' && value !== 'all'
  ).length;

  return {
    query,
    setQuery,
    filters,
    setFilter,
    clearFilters,
    activeFilterCount,
    sort,
    toggleSort,
    page: safePage,
    setPage,
    pageSize,
    setPageSize: changePageSize,
    totalPages,
    total,
    unfilteredTotal: rows.length,
    rows: pageRows,
    sorted,
    isFiltered: Boolean(query.trim()) || activeFilterCount > 0,
  };
}
