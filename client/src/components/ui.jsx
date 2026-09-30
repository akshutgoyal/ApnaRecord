import React, { useState } from 'react';

// Shared UI primitives for every surface.
//
// Two rules this file exists to enforce:
//
//   1. ONE STATUS VOCABULARY. `Status` renders the six states the whole product
//      uses (active / pending / expiring / expired / denied / revoked), always as
//      icon + text + tint. Colour alone is never the signal — teal versus amber
//      is precisely what a colourblind reader loses.
//
//   2. THREE STATES FOR EVERY DATA SURFACE. `Skeleton` is a real placeholder at
//      the real row height, `EmptyState` distinguishes "nothing exists yet" from
//      "your filter matched nothing", and `Callout` carries the error with a next
//      step rather than an apology.

export function Card({ title, subtitle, right, children, className = '', tone = 'default', as: Tag = 'section' }) {
  const tones = {
    default: 'border-line bg-white',
    warn: 'border-warn-200 bg-warn-50',
    danger: 'border-error-200 bg-error-50',
    ok: 'border-success-200 bg-success-50',
    info: 'border-peacock-200 bg-peacock-50',
    accent: 'border-marigold-200 bg-marigold-50',
    ink: 'border-ink-800 bg-ink-900 text-parchment',
  };
  const headerTone = tone === 'ink' ? 'border-line-dark' : 'border-line';
  return (
    <Tag className={`rounded-xl border shadow-card ${tones[tone]} ${className}`}>
      {(title || right) && (
        <header className={`flex items-start justify-between gap-3 border-b px-5 py-3.5 ${headerTone}`}>
          <div className="min-w-0">
            {title && (
              <h2 className={`text-sm font-semibold ${tone === 'ink' ? 'text-parchment' : 'text-ink'}`}>
                {title}
              </h2>
            )}
            {subtitle && (
              <p className={`mt-0.5 text-xs leading-relaxed ${tone === 'ink' ? 'text-parchment/60' : 'text-slate-500'}`}>
                {subtitle}
              </p>
            )}
          </div>
          {right}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </Tag>
  );
}

export function Field({ label, hint, children, error }) {
  return (
    <label className="block">
      {label && <span className="label">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1 block text-xs leading-relaxed text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-medium text-error-700">{error}</span>}
    </label>
  );
}

export function Copyable({ value, label, className = '' }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${value}`}
      className={`group inline-flex items-center gap-1.5 rounded-institutional border border-line bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600 hover:border-peacock-300 hover:text-peacock-700 ${className}`}
    >
      <span className="truncate">{label || value}</span>
      <span className="text-slate-400 group-hover:text-peacock-600">{copied ? '✓' : '⧉'}</span>
    </button>
  );
}

/** Free-form tinted label. For states, prefer <Status> so the vocabulary stays closed. */
export function Pill({ children, tone = 'slate', className = '' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600 ring-slate-200',
    peacock: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
    teal: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
    marigold: 'bg-marigold-50 text-marigold-700 ring-marigold-200',
    amber: 'bg-warn-50 text-warn-700 ring-warn-200',
    error: 'bg-error-50 text-error-700 ring-error-200',
    rose: 'bg-error-50 text-error-700 ring-error-200',
    success: 'bg-success-50 text-success-700 ring-success-200',
    emerald: 'bg-success-50 text-success-700 ring-success-200',
    ink: 'bg-ink-900 text-parchment ring-ink-700',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-institutional px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tones[tone] || tones.slate} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * The product's closed set of states. Use this instead of a bespoke Pill wherever
 * something *is* in a state rather than merely labelled.
 */
const STATUS = {
  active: { cls: 'status-active', icon: '●', label: 'Active' },
  pending: { cls: 'status-pending', icon: '◐', label: 'Pending' },
  expiring: { cls: 'status-expiring', icon: '◔', label: 'Expiring' },
  expired: { cls: 'status-expired', icon: '○', label: 'Expired' },
  denied: { cls: 'status-denied', icon: '✕', label: 'Denied' },
  revoked: { cls: 'status-revoked', icon: '⊘', label: 'Revoked' },
};

export function Status({ state = 'active', children, className = '' }) {
  const token = STATUS[state] || STATUS.active;
  return (
    <span className={`${token.cls} ${className}`}>
      <span aria-hidden="true">{token.icon}</span>
      {children || token.label}
    </span>
  );
}

export function Spinner({ className = '' }) {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-hidden="true"
    />
  );
}

export function Busy({ label = 'Working…' }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-slate-500">
      <Spinner /> {label}
    </span>
  );
}

/** A live dot. Marigold, and the only thing on the page allowed to pulse. */
export function LiveDot({ tone = 'marigold', className = '' }) {
  const tones = {
    marigold: 'bg-marigold-400',
    peacock: 'bg-peacock-500',
    success: 'bg-success-600',
    error: 'bg-error-600',
  };
  return (
    <span
      aria-hidden="true"
      className={`live-dot inline-block h-1.5 w-1.5 rounded-full ${tones[tone]} ${className}`}
    />
  );
}

/**
 * Empty states carry an argument, not a shrug. `variant` separates the two cases
 * people confuse: nothing exists yet (first run) versus nothing matched (filter).
 */
export function EmptyState({ title, hint, action, variant = 'first-run', className = '' }) {
  const icon = variant === 'filtered' ? '⌕' : variant === 'blocked' ? '⊘' : '○';
  return (
    <div
      className={`rounded-xl border border-dashed border-line-strong bg-slate-50/60 px-5 py-8 text-center ${className}`}
    >
      <p aria-hidden="true" className="text-lg text-slate-400">
        {icon}
      </p>
      <p className="mt-1.5 text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Callout({ tone = 'info', title, children, className = '', action }) {
  const tones = {
    info: 'border-peacock-200 bg-peacock-50 text-peacock-900',
    warn: 'border-warn-200 bg-warn-50 text-warn-700',
    danger: 'border-error-200 bg-error-50 text-error-700',
    ok: 'border-success-200 bg-success-50 text-success-700',
    accent: 'border-marigold-200 bg-marigold-50 text-marigold-700',
    ink: 'border-ink-700 bg-ink-900 text-parchment/85',
  };
  const icons = { info: '⌘', warn: '!', danger: '✕', ok: '✓', accent: '◔', ink: '◈' };
  return (
    <div className={`rounded-lg border px-4 py-3 text-xs leading-relaxed ${tones[tone]} ${className}`}>
      <div className="flex gap-2.5">
        <span aria-hidden="true" className="mt-px shrink-0 font-semibold opacity-70">
          {icons[tone]}
        </span>
        <div className="min-w-0">
          {title && <p className="mb-1 font-semibold">{title}</p>}
          {children}
          {action && <div className="mt-2">{action}</div>}
        </div>
      </div>
    </div>
  );
}

export function KeyValue({ items }) {
  return (
    <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
      {items.map(({ k, v, mono }) => (
        <div key={k} className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className={`truncate text-sm text-ink ${mono ? 'font-mono text-xs' : ''}`}>{v || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Page header for a console or dashboard.
 * `kicker` is the small-caps eyebrow; `aside` sits to the right.
 */
export function PageHeader({ eyebrow, kicker, title, lead, actions, aside }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        {(kicker || eyebrow) && (
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-peacock-700">
            {kicker || eyebrow}
          </p>
        )}
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {lead && <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{lead}</p>}
      </div>
      {(aside || actions) && <div className="flex items-center gap-2">{aside || actions}</div>}
    </header>
  );
}

/** Skeleton block. Sized to the thing it replaces, never a generic spinner. */
export function Skeleton({ className = 'h-4 w-full' }) {
  return <span className={`block animate-pulse rounded bg-slate-200/70 ${className}`} />;
}

/** Skeleton table rows at true row height, so the layout does not jump. */
export function SkeletonRows({ rows = 4, columns = 4, className = '' }) {
  return (
    <div className={`space-y-0 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 border-b border-line py-3 last:border-0">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={`h-3.5 ${columnIndex === 0 ? 'w-32' : columnIndex === columns - 1 ? 'w-16' : 'w-24'}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-xl border border-line bg-white p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-16" />
          <Skeleton className="mt-3 h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

/** Loading copy that names what is being waited on. */
export function LoadingPanel({ label = 'Reading the contract…' }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <Spinner /> {label}
    </div>
  );
}
