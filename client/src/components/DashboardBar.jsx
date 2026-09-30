import React from 'react';
import { downloadCsv, timestampedFilename } from '../lib/csv';
import { absoluteTime, relativeTime } from '../lib/format';
import { Status, LiveDot } from './ui';

/**
 * The strip above a dashboard that answers three questions before anyone reads a
 * single number: how old is this, where did it come from, and how do I make it
 * newer.
 *
 * "Read 12s ago · from cache" is not chrome — a dashboard that cannot date itself
 * invites people to trust a figure that stopped being true twenty minutes ago,
 * and this product's whole claim is honesty about the state of things.
 */
export function DashboardBar({ lastUpdated, refreshing, onRefresh, stats, children }) {
  const derived = stats?.cached
    ? stats?.stale
      ? { state: 'expired', label: 'server cache · refreshing' }
      : { state: 'active', label: 'server cache' }
    : { state: 'pending', label: 'read from the chain' };

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-white px-4 py-2.5 shadow-card">
      <span className="inline-flex items-center gap-2 text-[11px] text-slate-500">
        {refreshing ? <LiveDot tone="peacock" /> : <LiveDot tone="success" />}
        {lastUpdated ? (
          <>
            read <span className="font-medium text-slate-700">{relativeTime(lastUpdated)}</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span title={absoluteTime(lastUpdated)}>{absoluteTime(lastUpdated)}</span>
          </>
        ) : (
          'reading…'
        )}
      </span>

      <Status state={derived.state}>{derived.label}</Status>

      {stats?.chain?.blockNumber && (
        <span className="text-[11px] text-slate-500">
          block <span className="tabular-nums text-slate-700">{stats.chain.blockNumber}</span>
        </span>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="Re-read every value directly from the chain, bypassing the server cache"
          className="btn-secondary text-xs"
        >
          {refreshing ? (
            <>
              <LiveDot tone="peacock" /> Reading the chain…
            </>
          ) : (
            'Refresh from chain'
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Export what is on screen.
 *
 * Client-side on purpose: an endpoint that dumps a whole collection is a data
 * egress path that then needs its own authorisation, and this reader is already
 * authorised to see exactly the rows they are exporting. Filtered or sorted
 * views export what they show, which is what people expect and rarely what they
 * get.
 */
export function ExportButton({ filename, columns, rows, label = 'Export CSV', disabled }) {
  return (
    <button
      type="button"
      disabled={disabled || !rows || rows.length === 0}
      onClick={() => downloadCsv(timestampedFilename(filename), columns, rows)}
      title={
        rows && rows.length > 0
          ? `Download these ${rows.length} rows as CSV`
          : 'Nothing to export yet'
      }
      className="btn-secondary text-xs"
    >
      {label}
      {rows && rows.length > 0 && <span className="tabular-nums opacity-60">({rows.length})</span>}
    </button>
  );
}
