import React, { useMemo, useState } from 'react';
import { isAddress } from 'ethers';
import { useChain, shortAddress } from '../chain';
import { DEMO_ACCOUNTS } from '../config/demoAccounts';
import { Field } from './ui';

// Nobody should have to paste 42 hex characters. This input accepts either a
// known name or an address, offers the registered identities as one-click chips,
// and can fill in the connected wallet. It still validates properly, because a
// malformed address produces a confusing failure deep inside ethers.

export default function AddressInput({
  label = 'Wallet address',
  value,
  onChange,
  hint,
  showMyAddress = true,
  exclude = [],
}) {
  const { account } = useChain();
  const [text, setText] = useState(value || '');

  const excluded = useMemo(() => exclude.map((a) => String(a).toLowerCase()), [exclude]);
  const chips = DEMO_ACCOUNTS.filter((a) => !excluded.includes(a.address.toLowerCase()));

  const commit = (next) => {
    setText(next);
    onChange(next);
  };

  const error = text && !isAddress(text) ? 'That is not a valid Ethereum address.' : null;
  const valid = text && isAddress(text);

  return (
    <Field label={label} hint={error || hint} error={error}>
      <div className="relative">
        <input
          className={`input mono ${error ? 'border-error-300' : valid ? 'border-peacock-300' : ''}`}
          value={text}
          onChange={(event) => commit(event.target.value)}
          placeholder="0x… or pick one below"
          spellCheck={false}
          aria-invalid={Boolean(error)}
        />
        {valid && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-peacock-600"
          >
            ✓
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {chips.map((entry) => (
          <button
            key={entry.address}
            type="button"
            onClick={() => commit(entry.address)}
            title={entry.address}
            className="inline-flex items-center gap-1 rounded-institutional border border-line bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600 transition hover:border-peacock-300 hover:bg-peacock-50 hover:text-peacock-700"
          >
            {entry.label}
            <span className="font-mono text-[10px] text-slate-400">{shortAddress(entry.address)}</span>
          </button>
        ))}

        {showMyAddress && account && !excluded.includes(account.toLowerCase()) && (
          <button
            type="button"
            onClick={() => commit(account)}
            className="inline-flex items-center gap-1 rounded-institutional border border-peacock-200 bg-peacock-50 px-2 py-0.5 text-[11px] font-medium text-peacock-700 transition hover:bg-peacock-100"
          >
            Use my address
          </button>
        )}
      </div>
    </Field>
  );
}
