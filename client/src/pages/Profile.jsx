import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAddress } from 'ethers';
import { useChain, describeError } from '../chain';
import { getProfile, saveProfile, eraseProfile } from '../services/api';
import { Card, Callout, Field, Pill, Busy } from '../components/ui';
import { OffChainBadge } from '../components/viz/primitives';

/**
 * The exact statement the server expects, built identically on both sides.
 * Must stay byte-for-byte in step with profileMessage() in the backend.
 */
function profileMessage(address, timestamp) {
  return 'ApnaRecord profile update\n' + `address: ${getAddress(address)}\n` + `timestamp: ${timestamp}`;
}

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const EMPTY = {
  displayName: '',
  dateOfBirth: '',
  bloodGroup: '',
  allergies: '',
  emergencyContact: '',
};

const FIELD_KEYS = ['displayName', 'dateOfBirth', 'bloodGroup', 'allergies', 'emergencyContact'];

export default function Profile() {
  const { account, signMessage, identity } = useChain();
  const [form, setForm] = useState(EMPTY);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!account) {
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    getProfile(account)
      .then(({ profile }) => {
        if (!alive || !profile) return;
        setSaved(profile);
        setForm({
          displayName: profile.displayName || '',
          dateOfBirth: profile.dateOfBirth || '',
          bloodGroup: profile.bloodGroup || '',
          allergies: profile.allergies || '',
          emergencyContact: profile.emergencyContact || '',
        });
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [account]);

  const buildSignature = async () => {
    const timestamp = Date.now();
    const signature = await signMessage(profileMessage(account, timestamp));
    return { timestamp, signature };
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    setMessage(null);
    try {
      const { timestamp, signature } = await buildSignature();
      const result = await saveProfile(account, { ...form, timestamp, signature });
      setSaved(result.profile);
      setMessage({
        tone: 'ok',
        title: 'Profile saved',
        body: 'Signed by your wallet. Nothing here went on-chain, and the contract never learned a name.',
      });
    } catch (caught) {
      const described = describeError(caught);
      setError({ title: described.title, body: described.detail });
    } finally {
      setBusy(null);
    }
  };

  const erase = async () => {
    setBusy('erase');
    setError(null);
    setMessage(null);
    try {
      const { timestamp, signature } = await buildSignature();
      await eraseProfile(account, timestamp, signature);
      setSaved(null);
      setForm(EMPTY);
      setMessage({
        tone: 'info',
        title: 'Display profile erased',
        body: 'Your name is gone from our database. The on-chain record, its digest and its ownership are untouched — erasure here cannot rewrite the ledger, and does not need to.',
      });
    } catch (caught) {
      const described = describeError(caught);
      setError({ title: described.title, body: described.detail });
    } finally {
      setBusy(null);
    }
  };

  if (!account) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card title="Connect a wallet">
          <p className="text-sm leading-relaxed text-slate-600">
            Your display profile belongs to a wallet, so there is nothing to edit until one is
            connected.
          </p>
          <Link to="/access" className="btn-primary mt-4">
            Connect a wallet
          </Link>
        </Card>
      </div>
    );
  }

  const filled = FIELD_KEYS.filter((key) => form[key]).length;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-peacock-700">
          Patient · profile
        </p>
        <h1 className="font-display mt-1 text-2xl font-bold tracking-tight text-ink">
          Your details
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
          This is the only place ApnaRecord stores anything about you as a person, and it is
          deliberately off-chain. The contract knows this wallet as{' '}
          <strong className="text-ink">{identity.label || 'an unregistered address'}</strong> and
          nothing else.
        </p>
      </header>

      <Callout tone="info" title="Why this is off-chain, and why that matters">
        Putting a name on a public ledger would publish it forever and make it impossible to correct
        or erase. So the chain holds the facts that must not change — who owns the record, who may
        read it, what its digest is — and this page holds the human-readable label, which you own
        and can delete.
        <br />
        <br />
        Deleting this profile cannot touch your records. And if someone were to tamper with every
        name in our database, ownership, consent and verification would all still be correct.
      </Callout>

      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-[11px] text-slate-500">{account}</span>
        {saved && <OffChainBadge />}
        <Pill tone={saved ? 'success' : 'slate'}>{saved ? 'profile set' : 'no profile yet'}</Pill>
        <Pill tone="slate">
          {filled} of {FIELD_KEYS.length} fields
        </Pill>
      </div>

      <Card
        title="Display profile"
        subtitle="Saved with a signature from your wallet — there is no password to steal"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name">
            <input
              className="input"
              value={form.displayName}
              onChange={(event) => setForm((c) => ({ ...c, displayName: event.target.value }))}
              placeholder="e.g., Priya Sharma"
            />
          </Field>

          <Field label="Date of birth">
            <input
              type="date"
              className="input"
              value={form.dateOfBirth}
              onChange={(event) => setForm((c) => ({ ...c, dateOfBirth: event.target.value }))}
            />
          </Field>

          <Field label="Blood group">
            <div className="flex flex-wrap gap-1.5">
              {BLOOD_GROUPS.map((group) => (
                <button
                  key={group}
                  type="button"
                  aria-pressed={form.bloodGroup === group}
                  onClick={() => setForm((c) => ({ ...c, bloodGroup: group }))}
                  className={`rounded-institutional border px-2.5 py-1 text-[11px] font-medium transition ${
                    form.bloodGroup === group
                      ? 'border-peacock-300 bg-peacock-50 text-peacock-700'
                      : 'border-line bg-slate-50 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {group}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Emergency contact" hint="Name and number, as you would want it read aloud.">
            <input
              className="input"
              value={form.emergencyContact}
              onChange={(event) => setForm((c) => ({ ...c, emergencyContact: event.target.value }))}
              placeholder="e.g., Anil Sharma · +91 98••• •••••"
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Allergies" hint="Free text. This never leaves our database.">
              <textarea
                className="input min-h-[80px]"
                value={form.allergies}
                onChange={(event) => setForm((c) => ({ ...c, allergies: event.target.value }))}
                placeholder="e.g., Penicillin, latex"
              />
            </Field>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={save} disabled={Boolean(busy)} className="btn-primary">
            {busy === 'save' ? <Busy label="Signing in your wallet…" /> : 'Save with my signature'}
          </button>
          {saved && (
            <button
              type="button"
              onClick={erase}
              disabled={Boolean(busy)}
              className="btn-secondary border-error-200 text-error-700 hover:bg-error-50"
            >
              {busy === 'erase' ? <Busy label="Signing in your wallet…" /> : 'Erase my display data'}
            </button>
          )}
          <Link to="/patient" className="btn-ghost">
            Back to dashboard
          </Link>
        </div>

        {loading && <p className="mt-3 text-[11px] text-slate-400">Loading your saved profile…</p>}
      </Card>

      {message && (
        <Callout tone={message.tone} title={message.title}>
          {message.body}
        </Callout>
      )}

      {error && (
        <Callout tone="danger" title={error.title}>
          {error.body}
        </Callout>
      )}

      <Card title="What your signature actually authorises" subtitle="Worth knowing before you sign">
        <ul className="space-y-2.5 text-xs leading-relaxed text-slate-600">
          <li>
            MetaMask shows you this exact text before signing:
            <pre className="mono mt-1.5 overflow-x-auto rounded border border-line bg-slate-50 p-2.5 text-[10px] text-slate-700">
{`ApnaRecord profile update
address: ${account}
timestamp: <now>`}
            </pre>
          </li>
          <li>
            It is <strong className="text-ink">not a transaction</strong>. It costs no gas, changes
            nothing on-chain, and cannot move a record.
          </li>
          <li>
            The timestamp keeps it fresh — the server rejects a signature older than five minutes, so
            a captured signature cannot be replayed later.
          </li>
        </ul>
      </Card>
    </div>
  );
}
