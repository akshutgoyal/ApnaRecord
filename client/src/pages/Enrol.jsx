import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Brand from '../components/Brand';
import { useChain } from '../chain';
import { createWallet, generateRecoveryCode, sealPrivateKey } from '../lib/keystore';
import { saveSession } from '../lib/session';
import { enrolMessage } from '../lib/wireMessages';
import { enrolWallet, requestEmailCode, verifyEmailCode } from '../services/api';

const REMEMBER_KEY = 'apnarecord-last-address';

/**
 * Create a wallet without the user ever meeting one.
 *
 * The whole point is that there is no seed phrase, no extension, no network
 * switcher and no gas. What the user gets instead is a recovery code on paper —
 * which is the only thing standing between them and losing the wallet, so the
 * screen treats it that way rather than tucking it into a corner.
 */
export default function Enrol() {
  const { adoptSession } = useChain();
  const navigate = useNavigate();

  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  // Only ever populated by the mock sender, so a demo needs no provider account.
  const [devCode, setDevCode] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState(false);

  async function sendCode() {
    setSending(true);
    setError(null);
    try {
      const sent = await requestEmailCode(email.trim());
      setDevCode(sent.devCode || null);
      setStep('verify');
    } catch (problem) {
      setError(problem.message);
    } finally {
      setSending(false);
    }
  }

  async function checkCode() {
    setSending(true);
    setError(null);
    try {
      const grant = await verifyEmailCode(email.trim(), code);
      await create(grant.token);
    } catch (problem) {
      setError(problem.message);
    } finally {
      setSending(false);
    }
  }

  /**
   * Only reached once the email address is verified. The grant is what turns the
   * address on the enrolment from a claim into a verified binding — and it is also
   * what will later let this address locate the wallet on a new device.
   */
  async function create(grantToken) {
    setStep('creating');
    setError(null);
    try {
      // 1. The key, made here. Nothing about it is sent anywhere until it is sealed.
      const { address, privateKey } = createWallet();

      // 2. The recovery code, and the key locked behind it. This is the slow call —
      //    600k PBKDF2 iterations, deliberately.
      const code = generateRecoveryCode();
      const sealed = await sealPrivateKey(privateKey, code);

      // 3. Hand the server ciphertext, a signature proving we hold the key, and the
      //    grant proving we control the address being bound. Those are two different
      //    claims and both are required.
      const { Wallet } = await import('ethers');
      const timestamp = Date.now();
      const signature = await new Wallet(privateKey).signMessage(
        enrolMessage(address, timestamp)
      );

      const created = await enrolWallet({
        address,
        sealed: sealed.sealed,
        salt: sealed.salt,
        iterations: sealed.iterations,
        timestamp,
        signature,
        grantToken,
      });

      // 4. Remember which blob belongs to this device. The address is public, so
      //    this is a convenience, not a secret.
      try {
        localStorage.setItem(REMEMBER_KEY, address);
      } catch {
        /* private mode — the address can be typed at unlock instead */
      }

      // 5. In, before the code is even written down. A user who closes the tab here
      //    still has a working wallet; they have simply lost it until they find the
      //    code, which is why the next screen is emphatic about the paper.
      saveSession({ address, privateKey });
      await adoptSession(address);

      setResult({ address, code, drip: created.drip });
      setStep('code');
    } catch (problem) {
      setError(problem.message || 'Something went wrong while creating the wallet.');
      setStep('email');
    }
  }

  function printable() {
    if (!result) return;
    const text = [
      'ApnaRecord recovery code',
      '',
      'Wallet address: ' + result.address,
      'Recovery code:  ' + result.code,
      '',
      'This code is the only way to open this wallet. Keep it offline.',
      'Anyone who has it can act as you. Do not photograph it or email it.',
      'ApnaRecord cannot reset it and cannot recover your records without it.',
    ].join('\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `apnarecord-recovery-${result.address.slice(2, 8)}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  if (step === 'verify') {
    return (
      <Shell>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-marigold-700">
          Verify your email
        </p>
        <h1 className="mt-1.5 font-display text-2xl font-semibold text-ink">
          Enter the code we sent
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Six digits to <span className="mono">{email}</span>. It expires in five minutes, and five
          wrong guesses lock it.
        </p>

        {/* The mock sender puts the code in the server log. Surfacing it here is what
            lets the whole flow be demonstrated with no relay account, no verified
            domain and no DNS records — and it disappears the moment a real sender
            is configured. */}
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
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-600">
              Six-digit code
            </span>
            <input
              className="input mono text-lg tracking-[0.3em]"
              placeholder="••••••"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          </label>

          {error && (
            <div className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="btn-primary"
              disabled={sending || code.length !== 6}
            >
              {sending ? 'Checking…' : 'Verify and continue'}
            </button>
            <button
              type="button"
              className="btn-ghost text-sm"
              onClick={sendCode}
              disabled={sending}
            >
              Send a new code
            </button>
          </div>
        </form>

        <p className="mt-6 text-xs leading-relaxed text-slate-500">
          Verifying the address lets us find your wallet later. It cannot open it — that always
          takes the recovery code, so someone who takes over your email still cannot read your
          records.
        </p>
      </Shell>
    );
  }

  if (step === 'creating') {
    return (
      <Shell>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Creating your wallet and locking it with your recovery code…
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          This takes a moment on purpose: the code is stretched 600,000 times before it becomes a
          key, which is what makes guessing it hopeless.
        </p>
      </Shell>
    );
  }

  if (step === 'code' && result) {
    return (
      <Shell wide>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-marigold-700">
          Step 1 of 1
        </p>
        <h1 className="mt-1.5 font-display text-2xl font-semibold text-ink">
          Write this recovery code down
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
          This is the only way to open your wallet on a new device. There is no reset, no email
          link, and no way for us to recover it — that is what makes your records yours.
        </p>

        <div className="mt-5 rounded-xl border-2 border-ink bg-ink p-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-parchment/60">
            Recovery code
          </p>
          <p className="mono mt-2 break-all text-xl font-semibold tracking-[0.12em] text-marigold-300 sm:text-2xl">
            {result.code}
          </p>
          <p className="mono mt-4 break-all text-[11px] text-parchment/50">{result.address}</p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => navigator.clipboard?.writeText(result.code)}
          >
            Copy code
          </button>
          <button type="button" className="btn-secondary" onClick={printable}>
            Download as a text file
          </button>
          <button type="button" className="btn-secondary" onClick={() => window.print()}>
            Print this page
          </button>
        </div>

        <ul className="mt-5 space-y-1.5 text-xs leading-relaxed text-slate-600">
          <li>• Write it on paper. A photo in your gallery is not offline storage.</li>
          <li>• Keep it somewhere you would keep a passport, not in your notes app.</li>
          <li>• Anyone who has this code can act as you. Do not share it, not even with us.</li>
        </ul>

        {/* The single most important warning in the product, stated plainly rather
            than buried. There is no reset, and because the record is soulbound it
            cannot be moved to a new wallet — so this is not "you will lose access
            until support helps", it is "this is gone". */}
        <div className="mt-5 rounded-lg border border-error-200 bg-error-50 p-3.5">
          <p className="text-sm font-semibold text-error-700">
            If you lose this code, your records are gone — not locked, gone
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-error-700/90">
            There is no reset link, no security question, and no way for us to recover it. Your
            records are bound to this wallet and cannot be transferred to a new one, so creating a
            fresh account will not get them back. This is the price of nobody but you being able to
            open your medical history, and it is why we ask you to write it down before you
            continue.
          </p>
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
          A second recovery method — an extra printed code, a passkey on another device, or a
          guardian who can approve a reset after a waiting period — is designed but not built yet.
          Until it is, this code is the only way in.
        </p>

        {result.drip && !result.drip.skipped && (
          <p className="mt-5 text-xs text-success-700">
            Your wallet has been funded with {result.drip.amountEth} test ETH, so you can act
            straight away without buying anything.
          </p>
        )}
        {result.drip?.skipped && (
          <p className="mt-5 text-xs text-warn-700">
            Your wallet was created, but it could not be funded automatically (
            {result.drip.reason}). Anything that writes to the chain will fail until it has gas.
          </p>
        )}

        <label className="mt-6 flex items-start gap-2.5 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          I have written the recovery code down and stored it somewhere safe.
        </label>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={!saved}
            onClick={() => navigate('/patient', { replace: true })}
          >
            Continue
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          Your wallet is ready. Records appear once an administrator registers your identity on the
          contract — until then there is genuinely nothing to show you, which is the correct
          answer rather than an error.
        </p>
      </Shell>
    );
  }

  return (
    <Shell wide>
      <h1 className="font-display text-2xl font-semibold text-ink">
        Create your ApnaRecord account
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
        No extension, no seed phrase, no gas to buy. We create a wallet for you in the background
        and lock it with a recovery code that only you hold.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Step
          n="1"
          title="We make a wallet"
          body="It is created in your browser. Nobody else ever has the key."
        />
        <Step
          n="2"
          title="You get a code"
          body="Twenty characters on paper. It is the only way to open the wallet elsewhere."
        />
        <Step
          n="3"
          title="We cover the fees"
          body="A small amount of test ETH is added so you never have to think about gas."
        />
      </div>

      <Callout>
        An administrator still has to register your identity on the contract before you can hold
        records, and only you can decide who is allowed to read them.
      </Callout>

      {error && (
        <div className="mt-5 rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700">
          {error}
        </div>
      )}

      <div className="mt-6 space-y-3">
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
          <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
            One code to prove the address is yours. We keep only a masked form —{' '}
            <span className="mono">a•••@example.com</span> — never the address itself, and never
            on the chain. It is how you find this wallet again on a new device.
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            onClick={sendCode}
            disabled={sending || !email.trim().includes('@')}
          >
            {sending ? 'Sending…' : 'Send my code'}
          </button>
          <Link to="/unlock" className="text-sm font-medium text-peacock-700 underline">
            I already have a wallet
          </Link>
        </div>
      </div>
    </Shell>
  );
}

function Step({ n, title, body }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4">
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-peacock-50 text-[11px] font-semibold text-peacock-700">
        {n}
      </span>
      <p className="mt-2 text-sm font-semibold text-ink">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

function Callout({ children }) {
  return (
    <div className="mt-5 rounded-lg border border-line bg-parchment/60 p-3.5 text-xs leading-relaxed text-slate-700">
      {children}
    </div>
  );
}

function Shell({ children, wide = false }) {
  return (
    <div className="min-h-screen bg-paper">
      <div className="border-b border-line bg-ink px-5 py-4">
        <Link to="/" className="inline-flex">
          <Brand />
        </Link>
      </div>
      <div className={wide ? 'mx-auto max-w-3xl px-5 py-10' : 'mx-auto max-w-xl px-5 py-16'}>
        {children}
      </div>
    </div>
  );
}
