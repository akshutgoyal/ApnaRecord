import React, { useEffect, useState } from 'react';
import { useChain } from '../chain';
import { CONTRACT_ADDRESS, CHAIN_ID, EXPLORER } from '../contract';
import { chainStatus } from '../services/api';
import { LiveDot } from './ui';

// Global state lives here, in one sticky strip — not scattered across pages as
// per-page notices. Three facts, always: is the read path live, what network are
// we on, and which contract are we talking to.
//
// The dot is a live dot only when it means "live". A pulsing indicator over a
// dead RPC endpoint is worse than no indicator.

export default function StatusBanner() {
  const { wrongNetwork, switchNetwork, hasWallet } = useChain();
  const [api, setApi] = useState({ state: 'checking' });

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const status = await chainStatus();
        if (!alive) return;
        setApi({ state: 'ok', ...status });
      } catch (error) {
        if (!alive) return;
        setApi({ state: 'down', message: error.message });
      }
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const healthy = api.state === 'ok' && !wrongNetwork;

  const state = wrongNetwork ? 'wrong' : api.state === 'down' ? 'down' : healthy ? 'ok' : 'checking';

  const shell = {
    ok: 'border-line bg-paper text-slate-600',
    checking: 'border-line bg-paper text-slate-600',
    wrong: 'border-marigold-200 bg-marigold-50 text-marigold-700',
    down: 'border-error-200 bg-error-50 text-error-700',
  }[state];

  const label = {
    ok: 'Sepolia · live',
    checking: 'Checking the chain…',
    wrong: 'Wrong network',
    down: 'Chain unreachable',
  }[state];

  const dot = { ok: 'success', checking: 'peacock', wrong: 'marigold', down: 'error' }[state];

  return (
    <div className={`border-b text-[11px] ${shell}`}>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <LiveDot tone={dot} />
          {label}
        </span>

        <span aria-hidden="true" className="hidden text-slate-300 sm:inline">
          |
        </span>

        <span className="inline-flex items-center gap-1.5">
          contract{' '}
          <a
            href={EXPLORER}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline decoration-dotted underline-offset-2 hover:text-peacock-700"
          >
            {CONTRACT_ADDRESS.slice(0, 8)}…{CONTRACT_ADDRESS.slice(-6)}
          </a>
          <span aria-hidden="true" className="text-slate-400">
            ↗
          </span>
        </span>

        <span aria-hidden="true" className="hidden text-slate-300 sm:inline">
          |
        </span>
        <span>Chain ID {CHAIN_ID}</span>

        <span aria-hidden="true" className="hidden text-slate-300 sm:inline">
          |
        </span>
        <span>
          api{' '}
          {api.state === 'checking'
            ? 'checking…'
            : api.state === 'ok'
              ? `ok · next token #${api.nextTokenId ?? '—'}`
              : 'unreachable'}
        </span>

        {wrongNetwork && hasWallet && (
          <button
            type="button"
            onClick={switchNetwork}
            className="ml-auto rounded border border-marigold-300 bg-white px-2 py-0.5 font-medium text-marigold-700 hover:bg-marigold-50"
          >
            Switch to Sepolia
          </button>
        )}
      </div>
    </div>
  );
}
