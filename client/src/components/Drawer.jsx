import React, { useEffect, useRef } from 'react';

/**
 * A detail panel that slides in from the right.
 *
 * Chosen over a modal on purpose. A dashboard's job is to keep the table, the
 * filters and the surrounding context on screen while you look at one row — a
 * modal covers exactly the thing you wanted to compare against.
 *
 * The overlay is a real button so click-outside works on touch and for keyboard
 * users, and Escape closes without trapping anyone.
 */
export default function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-xl' }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);

    // Move focus into the panel so Escape and Tab start from the right place.
    const focusTimer = setTimeout(() => {
      const target = panelRef.current?.querySelector('[data-autofocus]') || panelRef.current;
      target?.focus?.();
    }, 30);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[1px]"
      />

      <section
        ref={panelRef}
        tabIndex={-1}
        className={`relative flex h-full w-full ${width} flex-col border-l border-line bg-paper shadow-overlay outline-none`}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line bg-white px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-display truncate text-[15px] font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            data-autofocus
            aria-label="Close panel"
            className="-mr-1 -mt-1 shrink-0 rounded-md px-2 py-1 text-slate-400 transition hover:bg-slate-100 hover:text-ink"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="shrink-0 border-t border-line bg-white px-5 py-3">{footer}</footer>
        )}
      </section>
    </div>
  );
}
