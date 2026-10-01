import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

// Toasts clear themselves. Success sits for 3s; anything that is part of the
// argument — a refusal, a revert — stays longer, because the refusal is often
// the point being demonstrated.

const ToastContext = createContext(null);

const TONE = {
  ok: { wrap: 'border-success-200', bar: 'bg-success-600', title: 'text-success-700', icon: '✓' },
  error: { wrap: 'border-error-200', bar: 'bg-error-600', title: 'text-error-700', icon: '✕' },
  info: { wrap: 'border-line', bar: 'bg-peacock-600', title: 'text-ink', icon: '◈' },
  warn: { wrap: 'border-warn-200', bar: 'bg-warn-500', title: 'text-warn-700', icon: '!' },
  accent: { wrap: 'border-marigold-200', bar: 'bg-marigold-400', title: 'text-marigold-700', icon: '◔' },
  // A settled on-chain outcome. Distinct from `ok` because it stays on screen until
  // dismissed, and because it is the one the user is meant to keep.
  chain: { wrap: 'border-peacock-300', bar: 'bg-peacock-600', title: 'text-peacock-700', icon: '◈' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const tone = toast.tone || 'info';
      // A write outcome does not expire on a timer.
      //
      // It used to: 3s for success. The audit of the eight largest US EHR patient
      // portals found the worst failure mode there was silent failure — a failed
      // upload that "routinely results in the practice never receiving the document
      // at all, because the silent failure mode produces no error and no record." For
      // this product it is worse: the on-chain anchor is the only proof the record
      // exists, so a user who looks away from a 3-second toast has no way to learn
      // the mint succeeded. `ttl: Infinity` keeps it up until it is dismissed, which
      // is also what a screen reader needs — a polite live region that empties itself
      // is announced and then gone.
      //
      // Non-blocking toasts (someone tapping through a demo) can still ask for a
      // timer by passing an explicit `ttl`, so this is a default rather than a ban.
      const ttl = toast.ttl ?? (tone === 'chain' || tone === 'error' || tone === 'warn' ? Infinity : 9000);
      setToasts((current) => [...current.slice(-3), { id, tone, ...toast }]);
      if (Number.isFinite(ttl)) {
        setTimeout(() => dismiss(id), ttl);
      }
      return id;
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      push,
      dismiss,
      // Chain outcomes get their own tone so the permanence is a property of the
      // category rather than a length someone has to remember to pass.
      chain: (title, detail) => push({ tone: 'chain', title, detail }),
      ok: (title, detail) => push({ tone: 'ok', title, detail }),
      error: (title, detail) => push({ tone: 'error', title, detail }),
      info: (title, detail) => push({ tone: 'info', title, detail }),
      warn: (title, detail) => push({ tone: 'warn', title, detail }),
      accent: (title, detail) => push({ tone: 'accent', title, detail }),
    }),
    [push, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* bottom-left on narrow screens so the thumb never covers it; bottom-right
          on desktop where the eye already is. */}
      <div
        className="pointer-events-none fixed bottom-4 left-4 right-4 z-50 flex flex-col gap-2 sm:left-auto sm:w-full sm:max-w-sm"
        aria-live="polite"
      >
        {toasts.map((toast) => {
          const tone = TONE[toast.tone] || TONE.info;
          return (
            <div
              key={toast.id}
              role="status"
              className={`pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border bg-white px-4 py-3 shadow-overlay ${tone.wrap}`}
            >
              <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${tone.bar}`} />
              <span aria-hidden="true" className={`mt-0.5 text-xs font-bold ${tone.title}`}>
                {tone.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-semibold ${tone.title}`}>{toast.title}</p>
                {toast.detail && (
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-slate-600">{toast.detail}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="-mr-1 -mt-1 rounded px-1.5 py-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
