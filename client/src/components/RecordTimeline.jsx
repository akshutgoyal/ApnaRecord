import React, { useCallback, useEffect, useState } from 'react';
import { recordHistory } from '../services/api';
import { TX_EXPLORER } from '../contract';
import { absoluteTime, relativeTime, humanType, shortAddress } from '../lib/format';
import { Callout, Pill, SkeletonRows, LiveDot } from './ui';

// Per-event presentation. The colour is meaning, not decoration: a refusal and a
// grant must not look alike at a glance.
const EVENT_TONE = {
  IdentityCreated: 'peacock',
  RecordRequested: 'slate',
  RecordMinted: 'peacock',
  Locked: 'slate',
  AccessGranted: 'success',
  AccessRevoked: 'error',
  RecordRevoked: 'error',
  EmergencyAccessUsed: 'marigold',
  RoleGranted: 'peacock',
};

/**
 * One record's whole life, oldest first.
 *
 * This is what a drill-down opens into. A global log answers "what has happened
 * here"; this answers "what happened to *this*", which is the question someone
 * actually has when they click a row.
 *
 * The fetch lives here rather than in the parent so the timeline can load, fail
 * and retry without the surrounding table knowing anything about it.
 */
export default function RecordTimeline({ tokenId, className = '' }) {
  const [state, setState] = useState({ loading: true, error: null, events: [], record: null });

  const load = useCallback(async () => {
    if (!tokenId) return;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const payload = await recordHistory(tokenId);
      setState({ loading: false, error: null, events: payload.events || [], record: payload.record });
    } catch (error) {
      setState({ loading: false, error: error.message, events: [], record: null });
    }
  }, [tokenId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!tokenId) return null;

  if (state.loading) {
    return (
      <div className={className}>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Reading this record's history…
        </p>
        <SkeletonRows rows={4} columns={2} />
      </div>
    );
  }

  if (state.error) {
    return (
      <Callout tone="danger" title="Could not read this record's history" action={
        <button type="button" onClick={load} className="btn-secondary">
          Retry
        </button>
      }>
        {state.error}
      </Callout>
    );
  }

  if (state.events.length === 0) {
    return (
      <Callout tone="info" title="No events for this record">
        The chain has no events recorded against token #{tokenId} that this server can read.
      </Callout>
    );
  }

  return (
    <div className={className}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Pill tone="slate">{state.events.length} events</Pill>
        <span className="text-[11px] text-slate-500">
          oldest first · {humanType(state.record?.recordType)}
        </span>
      </div>

      <ol className="relative space-y-0 border-l border-line pl-4">
        {state.events.map((event, index) => {
          const tone = EVENT_TONE[event.name] || 'slate';
          const isLast = index === state.events.length - 1;
          return (
            <li key={`${event.txHash}-${event.index ?? index}`} className={`relative ${isLast ? '' : 'pb-4'}`}>
              <span
                aria-hidden="true"
                className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-paper ${
                  {
                    peacock: 'bg-peacock-600',
                    success: 'bg-success-600',
                    error: 'bg-error-600',
                    marigold: 'bg-marigold-400',
                    slate: 'bg-slate-300',
                  }[tone]
                }`}
              />
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className="text-xs font-semibold text-ink">{event.name}</span>
                <Pill tone={tone}>{event.actorLabel || (event.actor ? shortAddress(event.actor) : 'system')}</Pill>
                <span className="ml-auto text-[10px] tabular-nums text-slate-400">
                  block {event.blockNumber}
                </span>
              </div>

              <p className="mt-1 text-[11px] text-slate-500">
                <span title={absoluteTime(event.timestamp)}>{relativeTime(event.timestamp)}</span>
                <span aria-hidden="true" className="mx-1.5 text-slate-300">·</span>
                {absoluteTime(event.timestamp)}
              </p>

              <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(event.args || {})
                  .filter(([key, value]) => value !== '' && value !== null && key !== 'tokenId')
                  .slice(0, 4)
                  .map(([key, value]) => (
                    <div key={key} className="min-w-0">
                      <dt className="text-[9px] uppercase tracking-wide text-slate-400">{key}</dt>
                      <dd className="mono max-w-[18rem] truncate text-slate-600" title={String(value)}>
                        {String(value)}
                      </dd>
                    </div>
                  ))}
              </dl>

              <a
                href={`${TX_EXPLORER}${event.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-[10px] text-peacock-700 underline decoration-dotted underline-offset-2"
              >
                view transaction ↗
              </a>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-[11px] text-slate-500">
        <LiveDot tone="peacock" />
        Beginning of history. Nothing precedes the first event, and nothing here can be edited.
      </p>
    </div>
  );
}
