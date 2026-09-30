import React, { useState } from 'react';

// Visual primitives shared by every dashboard. Kept dumb and presentational so a
// dashboard file reads as layout, not as styling.

// Teal-to-marigold: adjacent hues stay distinguishable for the most common forms
// of colour blindness, which is the whole reason this palette was chosen.
export const CHART_COLORS = ['#0E6E62', '#2E8B7C', '#6FB0A7', '#A8CFC9', '#D99A00', '#8A6200'];

const ACCENT = {
  default: 'before:bg-slate-300',
  peacock: 'before:bg-peacock-600',
  teal: 'before:bg-peacock-600',
  marigold: 'before:bg-marigold-400',
  amber: 'before:bg-warn-500',
  success: 'before:bg-success-600',
  emerald: 'before:bg-success-600',
  error: 'before:bg-error-600',
  rose: 'before:bg-error-600',
  ink: 'before:bg-ink-900',
};

/**
 * A KPI tile.
 *
 * Deliberately restrained: one number, one label, at most one comparison, at
 * most one visual. The multi-colour icon grid that usually lives here makes every
 * number shout, so none of them land. Irreversible or negative metrics get a
 * coloured left rule instead of a coloured card.
 *
 * `stale` greys the number when the last chain read failed. On a product whose
 * whole claim is honesty about state, showing a confident stale number is the one
 * unforgivable bug.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  delta,
  stale = false,
  onClick,
  className = '',
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`relative w-full overflow-hidden rounded-xl border border-line bg-white py-4 pl-5 pr-4 text-left shadow-card
                  before:absolute before:inset-y-0 before:left-0 before:w-[3px] ${ACCENT[tone] || ACCENT.default}
                  ${onClick ? 'transition hover:border-peacock-300 hover:shadow-raised' : ''} ${className}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          className={`font-display text-[28px] font-bold leading-none tabular-nums ${
            stale ? 'text-slate-400' : 'text-ink'
          }`}
        >
          {value}
        </span>
        {delta && <span className="text-[11px] font-medium text-slate-500">{delta}</span>}
        {stale && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-warn-600"
            title="The last chain read failed. This number may be out of date."
          >
            <span aria-hidden="true">!</span> stale
          </span>
        )}
      </div>
      {hint && <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{hint}</p>}
    </Tag>
  );
}

export function ChartCard({ title, subtitle, right, children, className = '', height = 240, footer }) {
  return (
    <section className={`rounded-xl border border-line bg-white shadow-card ${className}`}>
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className="px-2 py-3" style={{ height }}>
        {children}
      </div>
      {footer && <div className="border-t border-line px-4 py-3">{footer}</div>}
    </section>
  );
}

export function ProgressBar({ value, max = 100, tone = 'peacock', label, sublabel, className = '' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tones = {
    peacock: 'bg-peacock-600',
    teal: 'bg-peacock-600',
    marigold: 'bg-marigold-400',
    success: 'bg-success-600',
    emerald: 'bg-success-600',
    amber: 'bg-warn-500',
    error: 'bg-error-600',
    rose: 'bg-error-600',
    slate: 'bg-slate-400',
  };
  return (
    <div className={className}>
      {(label || sublabel) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="truncate text-xs text-slate-600">{label}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-slate-500">{sublabel || `${pct}%`}</span>
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label || 'progress'}
      >
        <div className={`h-full rounded-full transition-all ${tones[tone] || tones.peacock}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const PAGE_SIZES = [10, 25, 50];

/**
 * The canonical table.
 *
 * Rules baked in because they are the ones that get forgotten: the header sticks,
 * the first column can freeze with a shadow on the edge, numbers right-align and
 * text left-aligns, and the footer always states how many of how many are shown.
 * Density is a real toggle, not a comment.
 *
 * Sorting and paging are controlled from outside (see useTableState) rather than
 * held internally, so a dashboard can drive several tables — and the URL — from
 * one source of truth.
 *
 * `empty` is the first-run case; `emptyFiltered` is the different sentence a
 * filtered-to-zero table needs. "No records exist" is a lie when nine do.
 */
export function DataTable({
  columns,
  rows,
  empty = 'Nothing to show yet',
  emptyFiltered,
  rowKey,
  onRowClick,
  total,
  filtered = false,
  freezeFirstColumn = false,
  toolbar,
  bulkActions,
  selection,
  onToggleRow,
  onToggleAll,
  // sorting
  sort,
  onToggleSort,
  // paging
  page,
  pageSize,
  totalPages,
  onPageChange,
  onPageSizeChange,
  showDensity = true,
}) {
  const [density, setDensity] = useState('comfortable');
  const cellY = density === 'compact' ? 'py-2' : 'py-2.5';

  const hasToolbar = Boolean(toolbar) || showDensity;
  const count = rows?.length ?? 0;
  const totalCount = typeof total === 'number' ? total : count;
  const paged = typeof onPageChange === 'function';

  const selectedCount = selection ? selection.size : 0;
  const allSelected = count > 0 && selectedCount === count;

  const rangeStart = paged ? (page - 1) * pageSize + 1 : 1;
  const rangeEnd = paged ? rangeStart + count - 1 : count;

  return (
    <div>
      {/* The toolbar slot. When rows are selected it becomes the bulk bar — it
          never floats over the rows, so the table height never jumps. */}
      {hasToolbar && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {selectedCount > 0 && bulkActions ? (
            <>
              <span className="text-xs font-semibold text-ink">{selectedCount} selected</span>
              <span aria-hidden="true" className="text-slate-300">
                ·
              </span>
              <div className="flex flex-wrap items-center gap-2">{bulkActions}</div>
              <button
                type="button"
                onClick={() => onToggleAll?.({ clear: true })}
                className="btn-ghost ml-auto text-xs"
              >
                Clear selection
              </button>
            </>
          ) : (
            <>
              {toolbar}
              {showDensity && (
                <div
                  className={`${toolbar ? '' : 'ml-auto'} flex items-center gap-1 rounded-lg border border-line bg-slate-50 p-0.5 ${
                    toolbar ? 'ml-auto' : ''
                  }`}
                >
                  {['comfortable', 'compact'].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDensity(mode)}
                      aria-pressed={density === mode}
                      className={`rounded-md px-2 py-0.5 text-[11px] font-medium capitalize transition ${
                        density === mode ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-ink'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {count === 0 ? (
        <p className="px-4 py-8 text-center text-xs leading-relaxed text-slate-500">
          {filtered && emptyFiltered ? emptyFiltered : empty}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-slate-50">
                {selection && (
                  <th scope="col" className="sticky top-0 z-20 bg-slate-50 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      checked={allSelected}
                      onChange={() => onToggleAll?.({ checked: !allSelected })}
                      className="h-3.5 w-3.5 rounded border-line-strong text-peacock-600 focus:ring-peacock-500/30"
                    />
                  </th>
                )}
                {columns.map((column, index) => {
                  const sortable = Boolean(onToggleSort) && column.sortable !== false;
                  const active = sort?.key === column.key;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={`sticky top-0 z-20 whitespace-nowrap bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${
                        active ? 'text-peacock-700' : 'text-slate-500'
                      } ${
                        column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : ''
                      } ${
                        freezeFirstColumn && index === 0
                          ? 'left-0 z-30 after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-line'
                          : ''
                      }`}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => onToggleSort(column.key)}
                          className={`inline-flex items-center gap-1 transition hover:text-ink ${
                            column.align === 'right' ? 'flex-row-reverse' : ''
                          }`}
                          title={`Sort by ${column.label}`}
                        >
                          {column.label}
                          <span aria-hidden="true" className="text-[9px]">
                            {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                          </span>
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const key = rowKey ? rowKey(row, index) : index;
                const isSelected = selection ? selection.has(key) : false;
                return (
                  <tr
                    key={key}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={
                      onRowClick
                        ? (event) => {
                            if (event.key === 'Enter') onRowClick(row);
                          }
                        : undefined
                    }
                    className={`border-b border-line last:border-0 transition-colors ${
                      onRowClick ? 'cursor-pointer focus-visible:bg-peacock-50/60' : ''
                    } ${isSelected ? 'bg-peacock-50/60' : 'hover:bg-slate-50/70'}`}
                  >
                    {selection && (
                      <td className={`px-3 ${cellY}`} onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label="Select row"
                          checked={isSelected}
                          onChange={() => onToggleRow?.(key)}
                          className="h-3.5 w-3.5 rounded border-line-strong text-peacock-600 focus:ring-peacock-500/30"
                        />
                      </td>
                    )}
                    {columns.map((column, columnIndex) => (
                      <td
                        key={column.key}
                        className={`px-3 align-middle text-xs text-slate-700 ${cellY} ${
                          column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : ''
                        } ${column.mono ? 'font-mono text-[11px]' : ''} ${
                          freezeFirstColumn && columnIndex === 0
                            ? 'sticky left-0 z-10 bg-white after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-line'
                            : ''
                        }`}
                      >
                        {column.render ? column.render(row, index) : row[column.key]}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {count > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-[11px] text-slate-500">
            Showing{' '}
            <span className="tabular-nums text-slate-700">
              {paged ? `${rangeStart}–${rangeEnd}` : count}
            </span>{' '}
            of <span className="tabular-nums text-slate-700">{totalCount}</span>
            {filtered && totalCount !== count && !paged && ' matching this filter'}
          </p>

          {paged && (
            <>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onPageChange(1)}
                  disabled={page <= 1}
                  className="btn-secondary px-2 py-1 text-[11px]"
                  aria-label="First page"
                >
                  «
                </button>
                <button
                  type="button"
                  onClick={() => onPageChange(page - 1)}
                  disabled={page <= 1}
                  className="btn-secondary px-2.5 py-1 text-[11px]"
                >
                  Prev
                </button>
                <span className="px-2 text-[11px] tabular-nums text-slate-500">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => onPageChange(page + 1)}
                  disabled={page >= totalPages}
                  className="btn-secondary px-2.5 py-1 text-[11px]"
                >
                  Next
                </button>
                <button
                  type="button"
                  onClick={() => onPageChange(totalPages)}
                  disabled={page >= totalPages}
                  className="btn-secondary px-2 py-1 text-[11px]"
                  aria-label="Last page"
                >
                  »
                </button>
              </div>

              {onPageSizeChange && (
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  Rows
                  <select
                    value={pageSize}
                    onChange={(event) => onPageSizeChange(Number(event.target.value))}
                    className="rounded-md border border-line bg-white px-1.5 py-0.5 text-[11px] text-ink"
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function DonutLegend({ data, colors = CHART_COLORS }) {
  return (
    <ul className="space-y-1.5">
      {data.map((entry, index) => (
        <li key={entry.name} className="flex items-center gap-2 text-xs">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: colors[index % colors.length] }}
          />
          <span className="truncate text-slate-600">{entry.name}</span>
          <span className="ml-auto font-medium tabular-nums text-ink">{entry.value}</span>
        </li>
      ))}
    </ul>
  );
}

export function EmptyPanel({ title, hint }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-white px-5 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">{hint}</p>}
    </div>
  );
}

/** The badge that keeps the honesty visible wherever a name is shown. */
export function OffChainBadge({ className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-institutional bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-500 ring-1 ring-inset ring-slate-200 ${className}`}
      title="Display name supplied by the patient off-chain. The chain knows this wallet only by its address and label."
    >
      off-chain
    </span>
  );
}
