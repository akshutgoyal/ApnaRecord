import React, { useCallback, useEffect, useState } from 'react';
import { describeError } from '../chain';
import { chainEvents } from '../services/api';
import { TX_EXPLORER } from '../contract';
import { Callout, Card, EmptyState, PageHeader, Pill, SkeletonRows } from '../components/ui';

// The console fetched forty; this page exists to show more than a panel can hold.
const LIMIT = 100;

/**
 * The audit trail, on its own page.
 *
 * It used to be a card at the bottom of the operations console, which meant
 * the one thing an operator watches after a transaction — did it land, and
 * what did it record — was the furthest thing down a page that grows with
 * every identity. Here it gets the height, and the console keeps the actions.
 */
export default function AuditLog() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await chainEvents({ limit: LIMIT });
      setEvents(result.events || []);
    } catch (error) {
      setLoadError(describeError(error).detail || error.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PageHeader
        kicker="Hospital IT · Admin"
        title="Audit trail"
        lead="Nobody maintains a log file. The chain is the log — every identity, role, link, request and record this contract has ever recorded, newest first."
        aside={
          <button type="button" onClick={load} className="btn-secondary">
            Reload
          </button>
        }
      />

      <Card
        className="mt-5"
        title="Events on this contract"
        subtitle="Read straight from the contract's logs. Nothing here is written by the server."
        right={<Pill tone="slate">{events.length} shown</Pill>}
      >
        {loadError && (
          <Callout tone="danger" title="Could not read from the backend">
            {loadError}
          </Callout>
        )}

        {loading && !events.length && !loadError && <SkeletonRows rows={8} columns={3} />}

        {!loading && !loadError && events.length === 0 && (
          <EmptyState title="No events yet" hint="Anything the contract records will appear here." />
        )}

        {/*
          As in the console: on a failed reload the rows that were already read stay
          on screen, because they are real, just not current. The note says so rather
          than letting a stale list read as a fresh one.
        */}
        {loadError && events.length > 0 && (
          <p className="mb-3 text-xs leading-relaxed text-slate-600">
            The list below is the last successful read. It may be out of date.
          </p>
        )}

        {events.length > 0 && (
          <ol className="space-y-2">
            {events.map((event) => (
              <li
                key={`${event.txHash}-${event.name}-${event.blockNumber}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-2 last:border-0 last:pb-0"
              >
                <Pill tone="slate">{event.name}</Pill>
                <span className="mono text-slate-400">block {event.blockNumber}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600">
                  {Object.entries(event.args)
                    .filter(([, v]) => v !== '' && v !== null)
                    .map(([k, v]) => `${k}=${String(v).slice(0, 22)}`)
                    .join('  ')}
                </span>
                <a
                  href={`${TX_EXPLORER}${event.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-peacock-700 underline decoration-dotted underline-offset-2"
                >
                  explorer ↗
                </a>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
