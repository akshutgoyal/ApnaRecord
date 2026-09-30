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
      const ttl = toast.ttl ?? (tone === 'error' || tone === 'warn' ? 5200 : 3000);
      setToasts((current) => [...current.slice(-3), { id, tone, ...toast }]);
      setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      push,
      dismiss,
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
