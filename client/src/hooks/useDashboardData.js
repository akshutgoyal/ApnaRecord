import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStats, listProfiles } from '../services/api';

// Dashboard data, fetched once per mount and on demand.
//
// Both hooks degrade rather than throw: a dashboard that renders with empty charts
// is more useful than one that renders an error page, and the surrounding shell
// already tells the reader the truth about connectivity.
//
// `useStats` distinguishes three things a naive hook conflates:
//   loading      — nothing has arrived yet, so show a skeleton
//   refreshing   — something is in flight over existing data, so show a spinner
//   lastUpdated  — when the numbers on screen were actually read
//
// The third one matters most. A dashboard that cannot say how old it is invites
// people to trust a number that stopped being true twenty minutes ago.

export function useStats({ autoRefreshMs = 45_000 } = {}) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const inFlight = useRef(false);

  const load = useCallback(async ({ fresh = false } = {}) => {
    // Two overlapping reads would race, and the slower one would win.
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const payload = await getStats({ fresh });
      setStats(payload);
      setLastUpdated(Date.now());
      setError(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (!autoRefreshMs) return undefined;
    const timer = setInterval(() => load(), autoRefreshMs);
    return () => clearInterval(timer);
  }, [load, autoRefreshMs]);

  return {
    stats,
    loading,
    refreshing,
    error,
    lastUpdated,
    /** Re-read from the server cache. Cheap — this is the polling path. */
    reload: useCallback(() => load(), [load]),
    /** Re-read the chain, bypassing the server's cache. This is the button. */
    refreshFromChain: useCallback(() => load({ fresh: true }), [load]),
  };
}

/**
 * Display profiles, plus a lookup that falls back to the on-chain label and then
 * the address — so a dashboard always has something human to show.
 */
export function useProfiles() {
  const [profiles, setProfiles] = useState([]);
  const [available, setAvailable] = useState(true);

  const load = useCallback(async () => {
    try {
      const { profiles: list } = await listProfiles();
      setProfiles(list || []);
      setAvailable(true);
    } catch {
      // The database is optional. Without it we simply show addresses.
      setProfiles([]);
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const nameFor = useCallback(
    (address, fallbackLabel) => {
      if (!address) return '—';
      const match = profiles.find((p) => p.account === String(address).toLowerCase());
      return match?.displayName || fallbackLabel || null;
    },
    [profiles]
  );

  const byAddress = useMemo(() => {
    const map = {};
    for (const profile of profiles) map[profile.account] = profile;
    return map;
  }, [profiles]);

  return { profiles, nameFor, byAddress, available, reload: load };
}
