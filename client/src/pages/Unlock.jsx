import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Brand from '../components/Brand';
import { useChain } from '../chain';
import { Callout, Card, Field } from '../components/ui';
import { looksLikeRecoveryCode, openPrivateKey } from '../lib/keystore';
import { linkDevice } from '../lib/session';
import { getWalletBlob, lookupWallets, requestEmailCode, verifyEmailCode } from '../services/api';

const REMEMBER_KEY = 'apnarecord-last-address';

/**
 * Open a wallet that already exists.
 *
 * Two paths, and the difference between them is what each one proves.
 *
 *   BY EMAIL — the recommended route. A code to the address proves you can receive
 *   messages sent there, which *locates* your wallet. It does not open it: the
 *   recovery code is still required, so someone who takes over your email gets a
 *   ciphertext they cannot use.
 *
 *   BY ADDRESS — the fallback, for when the address has changed. The wallet address is not
 *   a secret, so this path's protection is entirely the recovery code.
 *
 * Neither path can open a wallet on its own. That is the whole design.
 */
export default function Unlock() {
  const { adoptSession, locked, lockedAddress, unlockDevice } = useChain();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [devCode, setDevCode] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [chosen, setChosen] = useState(null);
  const [address, setAddress] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Only needed on the PIN path; a passkey prompts the platform itself.
  const [devicePin, setDevicePin] = useState('');

  // A returning device remembers which blob is its own.
  useEffect(() => {
    try {
      const remembered = localStorage.getItem(REMEMBER_KEY);
      if (remembered) {
        setAddress(remembered);
        setEmail('');
      }
    } catch {
      /* private mode */
    }
  }, []);

  const codeLooksRight = looksLikeRecoveryCode(recoveryCode);

  // THIS IS THE WHOLE POINT OF THE CHANGE.
  //
  // The wallet is already on this device, wrapped. Opening the app again should cost a
  // fingerprint or a PIN, not twenty characters transcribed off a piece of paper — which
  // is how a recovery code ends up in Notes and stops being a recovery code.
  const lockedHere = Boolean(locked && lockedAddress);

  async function unlockWithDevice() {
    setBusy(true);
    setError(null);
    try {
      await unlockDevice({ pin: devicePin });
      navigate(location.state?.from || '/', { replace: true });
    } catch (problem) {
      setError(problem.message || 'That did not unlock this device.');
    } finally {
      setBusy(false);
    }
  }

  if (lockedHere) {
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <Card title="Unlock this device">
          <p className="text-sm leading-relaxed text-slate-600">
            Your wallet is on this device.{' '}
            <span className="mono">{lockedAddress.slice(0, 10)}…</span> Opening it needs the
            fingerprint or PIN you set — not the recovery code. The code is still underneath if
            you ever move to a new device.
          </p>
          <div className="mt-4 space-y-3">
            <Field label="Device PIN" hint="Only needed if this device uses a PIN; a passkey prompts itself.">
              <input
                className="input"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={devicePin}
                onChange={(event) => setDevicePin(event.target.value.replace(/\D/g, ''))}
              />
            </Field>
            {error && <Callout tone="danger">{error}</Callout>}
            <button type="button" className="btn-primary w-full" disabled={busy} onClick={unlockWithDevice}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
            <Link to="/access" className="btn-secondary block w-full text-center">
              Open a different wallet
            </Link>
          </div>
        </Card>
      </div>
    );
  }



  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const sent = await requestEmailCode(email.trim());
      setDevCode(sent.devCode || null);
      setStep('code');
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  async function checkCode() {
    setBusy(true);
    setError(null);
    try {
      const grant = await verifyEmailCode(email.trim(), emailCode);
      // The grant is spent here, and it returns the blobs it entitles you to — so
      // no second round-trip is needed to collect them.
      const found = await lookupWallets(grant.token);
      if (found.wallets.length === 0) {
        setError(
          'That address is verified, but no wallet is bound to it. If you used a different ' +
            'address, try it — or use the wallet-address path below.'
        );
        setEmailCode('');
        setDevCode(null);
        setStep('email');
        return;
      }
      setWallets(found.wallets);
      if (found.wallets.length === 1) {
        setChosen(found.wallets[0]);
        setStep('unlock');
      } else {
        setStep('choose');
      }
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  async function useAddress() {
    setBusy(true);
    setError(null);
    try {
      const { enrolment } = await getWalletBlob(address.trim());
      setChosen(enrolment);
      setWallets([enrolment]);
      setStep('unlock');
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  async function unlock(event) {
    event.preventDefault();
    setError(null);

    if (!looksLikeRecoveryCode(recoveryCode)) {
      setError(
        'That does not look like a recovery code yet. They are 20 characters, in four groups of five.'
      );
      return;
    }

    setBusy(true);
    try {
      // The slow part, on purpose: 600k PBKDF2 iterations before the key exists.
      const privateKey = await openPrivateKey(chosen, recoveryCode);

      // Opening with the recovery code is also the moment to set this device up, so the
      // code does not have to be typed again here.
      await linkDevice({ address: chosen.address, privateKey });
      try {
        localStorage.setItem(REMEMBER_KEY, chosen.address);
      } catch {
        /* ignore */
      }
      await adoptSession(chosen.address);
      navigate('/patient', { replace: true });
    } catch (problem) {
      setError(problem.message || 'That wallet could not be opened.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-paper">
      <div className="border-b border-line bg-ink px-5 py-4">
        <Link to="/" className="inline-flex">
          <Brand />
        </Link>
      </div>

      <div className="mx-auto max-w-xl px-5 py-16">
        {/* ------------------------------------------------------------ by email */}
        {step === 'email' && (
          <>
            <h1 className="font-display text-2xl font-semibold text-ink">Open your wallet</h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Enter the email address you signed up with. We send one code to find your wallet —
              the recovery code you wrote down is still what opens it.
            </p>

            <div className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Email address
                </span>
                <input
                  className="input"
                  placeholder="you@example.com"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              {error && (
                <div className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700">
                  {error}
                </div>
              )}

              <button
                type="button"
                className="btn-primary"
                onClick={sendCode}
                disabled={busy || !email.trim().includes('@')}
              >
                {busy ? 'Sending…' : 'Send my code'}
              </button>
            </div>
          </>
        )}

        {/* ------------------------------------------------------------- the code */}
        {step === 'code' && (
          <>
            <h1 className="font-display text-2xl font-semibold text-ink">
              Enter the code we sent
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Six digits to <span className="mono">{email}</span>.
            </p>

            {devCode && (
              <div className="mt-4 rounded-lg border border-marigold-200 bg-marigold-50 p-3">
                <p className="text-xs font-semibold text-marigold-700">
                  Mock sender active — no email was sent
                </p>
                <p className="mt-1 text-xs text-marigold-700/90">
                  Your code is <span className="mono text-sm font-semibold">{devCode}</span>. Set
                  <span className="mono"> EMAIL_PROVIDER</span> to resend or brevo to send real messages.
                </p>
              </div>
            )}

            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                checkCode();
              }}
            >
              <input
                className="input mono text-lg tracking-[0.3em]"
                placeholder="••••••"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={emailCode}
                onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, ''))}
              />

              {error && (
                <div className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700">
                  {error}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" className="btn-primary" disabled={busy || emailCode.length !== 6}>
                  {busy ? 'Finding your wallet…' : 'Continue'}
                </button>
                <button type="button" className="btn-ghost text-sm" onClick={sendCode} disabled={busy}>
                  Send a new code
                </button>
              </div>
            </form>
          </>
        )}

        {/* ----------------------------------------------------------- which one */}
        {step === 'choose' && (
          <>
            <h1 className="font-display text-2xl font-semibold text-ink">
              You have {wallets.length} wallets on this address
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Pick the one you have the recovery code for. The code only opens the wallet it was
              created with.
            </p>
            <ul className="mt-5 space-y-2">
              {wallets.map((wallet) => (
                <li key={wallet.address}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg border border-line bg-white px-3.5 py-3 text-left transition hover:border-peacock-300 hover:bg-peacock-50/50"
                    onClick={() => {
                      setChosen(wallet);
                      setStep('unlock');
                    }}
                  >
                    <span className="mono min-w-0 flex-1 truncate text-xs text-slate-600">
                      {wallet.address}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-500">
                      created {new Date(wallet.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* -------------------------------------------------------- the recovery code */}
        {step === 'unlock' && chosen && (
          <>
            <h1 className="font-display text-2xl font-semibold text-ink">Enter your recovery code</h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Found your wallet. This is the part that actually opens it — and it never leaves this
              browser.
            </p>
            <p className="mono mt-3 break-all rounded-lg border border-line bg-white px-3 py-2 text-[11px] text-slate-500">
              {chosen.address}
            </p>

            <form className="mt-6 space-y-4" onSubmit={unlock}>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Recovery code
                </span>
                <input
                  className="input mono tracking-widest"
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                  autoComplete="off"
                  spellCheck="false"
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                />
                <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
                  Case does not matter, and <span className="mono">O</span> is read as{' '}
                  <span className="mono">0</span>.
                </span>
              </label>

              {recoveryCode.length > 0 && !codeLooksRight && (
                <p className="text-xs text-warn-700">
                  Not a full code yet — 20 characters across four groups of five.
                </p>
              )}

              {error && (
                <div className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700">
                  {error}
                </div>
              )}

              <button type="submit" className="btn-primary" disabled={busy || !codeLooksRight}>
                {busy ? 'Opening…' : 'Open wallet'}
              </button>
            </form>
          </>
        )}

        {/* ------------------------------------------------------------ by address */}
        {step === 'address' && (
          <>
            <h1 className="font-display text-2xl font-semibold text-ink">
              Find your wallet by address
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              For when your email has changed. Your wallet address is not a secret — the recovery code is
              what protects the wallet, and it is still required on the next screen.
            </p>
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                useAddress();
              }}
            >
              <input
                className="input mono"
                placeholder="0x…"
                autoComplete="off"
                spellCheck="false"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              {error && (
                <div className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700">
                  {error}
                </div>
              )}
              <button type="submit" className="btn-primary" disabled={busy || !address.trim()}>
                {busy ? 'Looking…' : 'Find wallet'}
              </button>
            </form>
          </>
        )}

        <div className="mt-8 space-y-2 border-t border-line pt-5 text-xs leading-relaxed text-slate-500">
          {step !== 'address' && (
            <p>
              Changed your email?{' '}
              <button
                type="button"
                className="font-medium text-peacock-700 underline"
                onClick={() => {
                  setError(null);
                  setStep('address');
                }}
              >
                Find your wallet by address instead
              </button>
            </p>
          )}
          <p>
            No wallet at all?{' '}
            <Link to="/enrol" className="font-medium text-peacock-700 underline">
              Create one
            </Link>
            . Losing the recovery code cannot be reset — there is no key escrow and no password to
            recover.
          </p>
        </div>
      </div>
    </div>
  );
}
