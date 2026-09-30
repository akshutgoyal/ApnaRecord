import { useCallback, useState } from 'react';
import { describeError } from '../chain';
import { useToast } from '../components/Toast';

/**
 * Runs one write at a time and reports the outcome in plain English.
 *
 * A revert is not treated as a crash. The contract refusing a call is the
 * behaviour we are demonstrating, so it is surfaced with its own name —
 * "Not your role", "Consent window has closed" — rather than as a stack trace.
 */
export function useTx({ onDone } = {}) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);

  const run = useCallback(
    async (label, fn, options = {}) => {
      setBusy(label);
      try {
        const result = await fn();
        if (options.success !== false && !options.silent) {
          // Titles and details may be functions so a deliberate revert can be
          // reported as the success it actually is.
          const title =
            typeof options.successTitle === 'function'
              ? options.successTitle(result)
              : options.successTitle || `${label} confirmed`;
          const detail =
            typeof options.successDetail === 'function'
              ? options.successDetail(result)
              : options.successDetail;
          toast.ok(title, detail);
        }
        if (onDone) await onDone();
        return { ok: true, result };
      } catch (error) {
        const described = describeError(error);
        // `silent` is for callers that render the outcome inline. Toasting as
        // well would report the same refusal twice.
        if (!options.silent) toast.error(described.title, described.detail);
        return { ok: false, error: described };
      } finally {
        setBusy(null);
      }
    },
    [onDone, toast]
  );

  return { busy, run, isBusy: (label) => busy === label, clear: () => setBusy(null) };
}
