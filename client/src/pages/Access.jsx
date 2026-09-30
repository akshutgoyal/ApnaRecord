import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useChain, hasWallet, shortAddress, demoAddressFor } from '../chain';
import { ROLES, ROLE_ORDER, CHAIN_NAME, CONTRACT_ADDRESS } from '../contract';
import { Card, Callout, Spinner, LiveDot } from '../components/ui';
import Brand from '../components/Brand';

// The wallet gate. /access is the only door into the product: it asks the visitor
// to connect MetaMask, reads the connected address's role from the contract, and
// routes each wallet to the ONE console it holds.
//
// A patient can never reach the admin console from here; a doctor can never reach
// the patient console. Which destination exists for a given wallet is decided by
// chain state, not by anything the visitor clicks.
//
// Below the wallet sits the demo bypass: a persona picker with the same four
// roles. A persona loads that account's REAL chain state through the backend —
// but there is no signer, so reads work while writes refuse.

const ROLE_BLURB = {
  admin: 'Hospital IT — full controls: identities, roles, records.',
  doctor: 'Clinician — handles records and requests under live consent.',
  auditor: 'Compliance — metadata and the event log, never the file.',
  patient: 'Record owner — your records, your consent, your call.',
};

const ROLE_ICON = { admin: '⌘', doctor: '✚', auditor: '◍', patient: '☺' };

/** The demo bypass: a persona picker with the four roles. Shown in BOTH walletless states. */
function DemoPicker({ open, onToggle, busy, onPick }) {
  return (
    <div className="border-t border-line pt-3">
      <button
        type="button"
        onClick={onToggle}
        className="mx-auto block text-[13px] font-medium text-slate-500 underline decoration-dotted underline-offset-4 transition hover:text-ink"
      >
        {open ? 'Hide the demo walkthrough' : 'View demo — no wallet needed'}
      </button>

      {open && (
        <div className="mt-3 space-y-2 text-left">
          <p className="text-[11px] leading-relaxed text-slate-500">
            Pick a persona. You will see that role's live dashboard — real chain data for the
            account it belongs to. Reads and charts work; anything that writes refuses, because
            there is no wallet to sign with.
          </p>
          {ROLE_ORDER.map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => onPick(role)}
              disabled={busy !== null}
              className="group flex w-full items-center gap-3 rounded-lg border border-line bg-white px-3.5 py-2.5 text-left transition hover:border-peacock-300 hover:bg-peacock-50/50 disabled:opacity-60"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-peacock-50 text-sm text-peacock-700">
                {ROLE_ICON[role]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-ink">
                  {busy === role ? 'Loading live state…' : `Explore as ${ROLES[role].label}`}
                </span>
                <span className="block truncate text-[11px] text-slate-500">{ROLE_BLURB[role]}</span>
                <span className="mono block truncate text-[10px] text-slate-400">
                  {demoAddressFor(role)}
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-slate-300 transition group-hover:text-peacock-600">
                →
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Access() {
  const {
    account,
    primaryRole,
    identity,
    connecting,
    refreshing,
    walletError,
    connect,
    wrongNetwork,
    switchNetwork,
    isDemo,
    enterDemo,
    exitDemo,
    hasLocalSession,
    endSession,
    topUpGas,
  } = useChain();
  const navigate = useNavigate();
  const location = useLocation();
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(null);
  const [topping, setTopping] = useState(false);
  const [topUpNote, setTopUpNote] = useState(null);

  async function topUp() {
    setTopping(true);
    setTopUpNote(null);
    try {
      const result = await topUpGas();
      setTopUpNote(
        result?.skipped
          ? 'No top-up needed — this wallet already has enough for a good while.'
          : `Sent ${result.amountEth} test ETH. It should land shortly.`
      );
    } catch (error) {
      setTopUpNote(error.message);
    } finally {
      setTopping(false);
    }
  }

  const from = location.state?.from;

  // A demo persona already active belongs on its own console, not on this page.
  // This effect only moves CONNECTED wallets; demo personas stay put so the
  // visitor can read this page, switch persona, or exit.
  useEffect(() => {
    if (account && primaryRole && !isDemo) {
      navigate(ROLES[primaryRole].path, { replace: true });
    }
  }, [account, primaryRole, isDemo, navigate]);

  const pickPersona = async (role) => {
    setDemoBusy(role);
    try {
      await enterDemo(role);
      navigate(ROLES[role].path, { replace: true });
    } finally {
      setDemoBusy(null);
    }
  };

  const demo = (
    <DemoPicker
      open={demoOpen}
      onToggle={() => setDemoOpen((value) => !value)}
      busy={demoBusy}
      onPick={pickPersona}
    />
  );

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
          <Link to="/" className="flex items-center">
            <Brand size="sm" tone="dark" />
          </Link>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Access
          </span>
          <div className="ml-auto">
            <Link to="/" className="text-sm text-slate-600 transition hover:text-ink">
              ← Back to home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-5 py-12">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-peacock-700">
          Access Dashboard
        </p>
        <h1 className="font-display mt-2 text-3xl font-bold tracking-tight text-ink">
          Your records, your key.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Your wallet is the sign-in — but you never have to see one. Creating an account takes a
          moment and produces a recovery code; from then on the contract decides which console
          opens, and every other access point stays hidden.
        </p>

        <Card
          className="mt-6"
          title={account ? 'Wallet connected' : 'Get started'}
          subtitle={
            account
              ? 'Reading your role from the contract…'
              : 'Nothing to install, and nothing to buy. We cover the fees.'
          }
        >
          {!account ? (
            <div className="space-y-3">
              {/* The default door. Almost nobody arriving here has a wallet, and
                  making them get one first was the single biggest drop-off. */}
              <Link
                to="/enrol"
                className="btn-primary flex w-full justify-center py-2.5 text-[15px]"
              >
                Create my account
              </Link>
              <Link to="/unlock" className="btn-secondary flex w-full justify-center">
                I already have a recovery code
              </Link>

              <p className="text-[11px] leading-relaxed text-slate-500">
                Creating an account makes a wallet for you in the background — no extension, no
                seed phrase, no test ETH to find. You get a recovery code on paper, and nothing
                else about the wallet ever needs your attention.
              </p>

              {/* Kept, but demoted. An existing wallet still works; it is simply no
                  longer the way in. */}
              <details className="rounded-lg border border-line bg-white px-3.5 py-3">
                <summary className="cursor-pointer text-[13px] font-medium text-slate-600">
                  I already have a wallet, or an extension
                </summary>
                <div className="mt-3 space-y-3">
                  <button
                    type="button"
                    onClick={connect}
                    disabled={connecting}
                    className="btn-secondary w-full"
                  >
                    {connecting ? (
                      <>
                        <Spinner /> Connecting…
                      </>
                    ) : (
                      'Connect an existing wallet'
                    )}
                  </button>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    {hasWallet()
                      ? 'This asks your extension to reveal your address — nothing is signed and nothing moves.'
                      : 'No extension was detected in this browser, so this will not do anything yet.'}
                  </p>
                </div>
              </details>

              {walletError && (
                <Callout tone="danger" title={walletError.title}>
                  {walletError.detail}
                </Callout>
              )}

              {demo}
            </div>
          ) : (
            <div className="space-y-3">
              {isDemo ? (
                <Callout
                  tone="accent"
                  title={`Exploring as ${identity.label || (primaryRole ? ROLES[primaryRole].label : 'persona')}`}
                >
                  Data and charts below are that persona's live chain data. Switch persona below, or
                  exit the demo to sign in with a real wallet.
                  <button type="button" onClick={exitDemo} className="btn-secondary mt-2 w-full">
                    Exit demo
                  </button>
                </Callout>
              ) : (
                wrongNetwork && (
                  <Callout tone="accent" title="Wrong network">
                    This contract lives on {CHAIN_NAME}. Switch networks in MetaMask to continue.
                    <button type="button" onClick={switchNetwork} className="btn-secondary mt-2 w-full">
                      Switch to {CHAIN_NAME}
                    </button>
                  </Callout>
                )
              )}

              <div className="flex items-center gap-3 rounded-lg border border-line bg-slate-50 px-3.5 py-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-peacock-50 text-sm text-peacock-700">
                  ◈
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {identity.label || 'Unregistered wallet'}
                  </p>
                  <p className="mono truncate text-slate-500">{shortAddress(account)}</p>
                </div>
                {isDemo && (
                  <span className="ml-auto shrink-0 rounded-institutional bg-marigold-50 px-2 py-0.5 text-[10px] font-semibold text-marigold-700 ring-1 ring-inset ring-marigold-200">
                    demo
                  </span>
                )}
              </div>

              {isDemo && primaryRole ? (
                <Callout tone="ok" title={`${ROLES[primaryRole].label} console ready`}>
                  {ROLE_BLURB[primaryRole]} You are exploring, not signed in — write actions will be
                  refused.
                  <span className="mt-2 block">
                    <Link to={ROLES[primaryRole].path} className="font-semibold underline">
                      Open the {ROLES[primaryRole].label} console →
                    </Link>
                  </span>
                </Callout>
              ) : wrongNetwork ? (
                <Callout tone="accent" title="Wrong network">
                  This contract lives on {CHAIN_NAME}. Switch networks in MetaMask to continue.
                  <button type="button" onClick={switchNetwork} className="btn-secondary mt-2 w-full">
                    Switch to {CHAIN_NAME}
                  </button>
                </Callout>
              ) : primaryRole ? (
                <Callout tone="ok" title={`${ROLES[primaryRole].label} — opening your dashboard`}>
                  {ROLE_BLURB[primaryRole]} Redirecting now…
                  <span className="mt-2 block">
                    <Link to={ROLES[primaryRole].path} className="font-semibold underline">
                      Open the {ROLES[primaryRole].label} console →
                    </Link>
                  </span>
                </Callout>
              ) : refreshing ? (
                <p className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner /> Reading the contract…
                </p>
              ) : (
                <Callout tone="warn" title="This wallet holds no role here">
                  Nothing is wrong — this address was simply never registered. An administrator has
                  to create an identity for {shortAddress(account)} and grant it a role before a
                  console can open.
                </Callout>
              )}

              {!isDemo && hasLocalSession && (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={topUp}
                      disabled={topping}
                      className="btn-secondary flex-1"
                    >
                      {topping ? 'Asking for test ETH…' : 'Top up test ETH'}
                    </button>
                    <button type="button" onClick={endSession} className="btn-secondary flex-1">
                      Lock this wallet
                    </button>
                  </div>
                  {topUpNote && (
                    <p className="text-[11px] leading-relaxed text-slate-500">{topUpNote}</p>
                  )}
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    Writes cost a little gas, and this wallet was given a float when it was created.
                    It also tops itself up automatically when it runs low — this button is for when
                    you would rather do it deliberately.
                  </p>
                </div>
              )}

              {isDemo && demo}
            </div>
          )}
        </Card>

        <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[13px] text-slate-500">
          <Link to="/verify" className="transition hover:text-ink">
            Verify a record
          </Link>
          <Link to="/" className="transition hover:text-ink">
            What is ApnaRecord?
          </Link>
        </div>

        <p className="mt-6 flex items-center justify-center gap-2 text-[11px] text-slate-400">
          <LiveDot tone="peacock" />
          Roles are read live from the contract at {shortAddress(CONTRACT_ADDRESS)} on {CHAIN_NAME}
        </p>
      </main>
    </div>
  );
}
