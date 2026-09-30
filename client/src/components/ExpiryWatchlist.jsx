import React from 'react';
import ConsentTimer from './ConsentTimer';
import { Status } from './ui';
import { shortAddress, humanType } from '../lib/format';

/**
 * Windows that are about to lapse.
 *
 * This is the one derived view that earns its place on three different
 * dashboards, because it answers a question no raw count can: not "how many
 * grants exist" but "which ones are about to close on me". A patient wants to
 * know a clinician is about to lose access mid-treatment; a clinician wants to
 * know their read is about to expire; an admin wants to see activity that is
 * about to become invisible.
 *
 * Sorted soonest-first, and it renders nothing at all when there is nothing to
 * say — an empty alert panel trains people to ignore alert panels.
 */
export default function ExpiryWatchlist({ items = [], title = 'Expiring soon', note, className = '' }) {
  if (items.length === 0) return null;

  return (
    <section className={`rounded-xl border border-marigold-200 bg-marigold-50 ${className}`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-marigold-200 px-4 py-3">
        <span aria-hidden="true" className="live-dot h-1.5 w-1.5 rounded-full bg-marigold-400" />
        <h3 className="text-sm font-semibold text-marigold-700">{title}</h3>
        <Status state="expiring">{items.length} closing</Status>
        {note && <p className="ml-auto text-[11px] text-marigold-700/80">{note}</p>}
      </header>

      <ul className="divide-y divide-marigold-200/70">
        {items.map((item) => (
          <li
            key={`${item.tokenId}-${item.viewer}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5"
          >
            <span className="text-xs font-semibold text-ink">
              {item.viewerLabel || shortAddress(item.viewer)}
            </span>
            <span className="text-[11px] text-slate-600">
              on <span className="font-medium">token #{item.tokenId}</span>
              {item.recordType && <> · {humanType(item.recordType)}</>}
            </span>
            <span className="ml-auto">
              <ConsentTimer expiresAt={item.expiresAt} label="Closes" showAbsolute={false} />
            </span>
          </li>
        ))}
      </ul>

      <p className="border-t border-marigold-200/70 px-4 py-2 text-[11px] leading-relaxed text-marigold-700/80">
        Nobody has to act on these. The contract closes each window on time, by itself.
      </p>
    </section>
  );
}
