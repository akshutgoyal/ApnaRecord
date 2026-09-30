// Time and block formatting.
//
// One rule, applied everywhere: relative time is a convenience and absolute time
// is the truth. Anything shown next to a block number or in an audit context gets
// the absolute form, and the relative form is only ever the shortcut.

/** "3m ago", "2h ago", "5d ago" — or "just now". */
export function relativeTime(value) {
  const ms = toMs(value);
  if (ms === null) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'in the future';
  if (diff < 45_000) return 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** "14 Feb 2026, 09:12" — the form an audit trail needs. */
export function absoluteTime(value, { withDate = true } = {}) {
  const ms = toMs(value);
  if (ms === null) return '—';
  const date = new Date(ms);
  const options = withDate
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' };
  return date.toLocaleString(undefined, options);
}

/** Short date only, for chart axes and day dividers. */
export function shortDate(value) {
  const ms = toMs(value);
  if (ms === null) return '—';
  return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/** The calendar day a timestamp falls on, as YYYY-MM-DD. */
export function dayKey(value) {
  const ms = toMs(value);
  if (ms === null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "in 47s", "in 3h", or null once it has passed. */
export function timeUntil(secondsFromNow) {
  if (!secondsFromNow) return null;
  const diffMs = secondsFromNow * 1000 - Date.now();
  if (diffMs <= 0) return null;
  const total = Math.floor(diffMs / 1000);
  if (total < 60) return `in ${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Human label for a SCREAMING_SNAKE record type. */
export function humanType(recordType) {
  return String(recordType || 'Record')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** 0x1234…abcd. */
export function shortAddress(address) {
  if (!address || typeof address !== 'string') return '—';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    // Seconds since epoch vs milliseconds: anything under 1e12 is seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
