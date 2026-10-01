import React from 'react';
import { Link } from 'react-router-dom';
import { EXPLORER, CONTRACT_ADDRESS, TX_EXPLORER } from '../contract';
import Brand from '../components/Brand';
import { Reveal } from '../hooks/useReveal';
import { LiveDot } from '../components/ui';

// The public site. Ink shell: #0C2431 surface, parchment text, marigold used
// only where something is genuinely live or genuinely time-bound.
//
// Composition follows the two things that actually persuade on a health product:
// show the product in the first screen (a real consent artefact, built in the
// DOM, not a screenshot), and then prove the claims with the artefacts that make
// them checkable — the revert strings, the digest, the contract address.
//
// Every claim below maps to something the contract does. Nothing here is
// aspirational.

const NAV = [
  { href: '#exhibits', label: 'Enforcement' },
  { href: '#lifecycle', label: 'Lifecycle' },
  { href: '#consent', label: 'Consent' },
  { href: '#limits', label: 'Limits' },
];

// The four roles, drawn around the contract. Positions are percentages of the
// SVG viewBox so the map scales with the hero.
const ORBIT_NODES = [
  { x: 50, y: 50, tag: '', label: 'Contract', sub: 'Sepolia', center: true },
  { x: 15, y: 25, tag: 'PP', label: 'Patient', sub: 'record owner' },
  { x: 85, y: 21, tag: 'CD', label: 'Cardiology', sub: 'manager · doctor' },
  { x: 83, y: 77, tag: 'HI', label: 'Hospital IT', sub: 'hospital · linked patients' },
  { x: 14, y: 75, tag: 'CA', label: 'Compliance', sub: 'auditor' },
];

const ORBIT_ROUTES = [
  'M 50 50 C 38 44, 25 37, 15 25',
  'M 50 50 C 63 40, 75 30, 85 21',
  'M 50 50 C 63 58, 75 66, 83 77',
  'M 50 50 C 36 56, 24 64, 14 75',
];

const TRUST_BADGES = [
  { label: 'ERC-5192 · soulbound' },
  { label: 'Sepolia testnet' },
  { label: 'keccak256 anchored' },
  { label: 'AES-256-GCM in-browser' },
  { label: 'W3C did:ethr' },
];

// The three refusals. These are the strongest thing on the page: they are not
// claims about behaviour, they are the behaviour, named.
const EXHIBITS = [
  {
    tag: 'Exhibit A',
    title: 'The owner cannot move the record',
    revert: 'Locked(uint256)',
    body: 'A record is a soulbound token. Transfer is not disabled by a flag — the code path to move one does not exist. Even the patient who owns it cannot sell, lend or lose it.',
  },
  {
    tag: 'Exhibit B',
    title: 'The hospital can mint but cannot read',
    revert: 'AccessDenied()',
    body: 'Hospital IT writes the record on-chain and then has no way back into the file. Minting and reading are different permissions, held by different parties, checked by the contract at every call.',
  },
  {
    tag: 'Exhibit C',
    title: 'Consent expires on its own',
    revert: 'Expired()',
    body: 'A window is time-boxed at the moment it is granted. When it closes, the next read reverts — no administrator action, no cron job, nothing to remember and nothing to forget.',
  },
];

// The consent artefact, decomposed. Lifted from the ABDM consent model, because
// anything less specific is a checkbox dressed as consent.
const ARTEFACT = [
  { k: 'Purpose', v: 'Care, or an audit — named at grant time' },
  { k: 'Who', v: 'One wallet address, never a group' },
  { k: 'What', v: 'One record, identified by token' },
  { k: 'How long', v: '60 seconds to 7 days, on-chain' },
  { k: 'Revocable', v: 'Always, instantly, forever after' },
];

const NINE_EVENTS = [
  'IdentityCreated',
  'RecordRequested',
  'RecordMinted',
  'Locked',
  'AccessGranted',
  'AccessRevoked',
  'EmergencyAccessUsed',
  'RecordRevoked',
  'RoleGranted',
];

function RouteMap() {
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden="true">
      <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(245,239,226,0.10)" strokeWidth="0.4" />
      <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(245,239,226,0.06)" strokeWidth="0.4" />
      {ORBIT_ROUTES.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="rgba(217,154,0,0.55)"
          strokeWidth="0.5"
          className="route-dash"
        />
      ))}
      {ORBIT_NODES.map((node) =>
        node.center ? (
          <g key={node.label}>
            <circle cx={node.x} cy={node.y} r="7" fill="#0E6E62" />
            <circle cx={node.x} cy={node.y} r="7" fill="none" stroke="rgba(217,154,0,0.5)" strokeWidth="1.4" />
            <text x={node.x} y={node.y + 1.5} textAnchor="middle" fill="#F5EFE2" fontSize="3.6" fontWeight="700">
              AR
            </text>
            <text x={node.x} y={node.y + 12} textAnchor="middle" fill="#F5EFE2" fontSize="3.2" fontWeight="600">
              {node.label}
            </text>
          </g>
        ) : (
          <g key={node.label}>
            <circle
              cx={node.x}
              cy={node.y}
              r="4.6"
              fill="#11313F"
              stroke="rgba(245,239,226,0.35)"
              strokeWidth="0.5"
            />
            <text x={node.x} y={node.y + 1.5} textAnchor="middle" fill="#F5EFE2" fontSize="2.9" fontWeight="700">
              {node.tag}
            </text>
            <text
              x={node.x}
              y={node.y + 8.6}
              textAnchor="middle"
              fill="rgba(245,239,226,0.85)"
              fontSize="2.9"
              fontWeight="600"
            >
              {node.label}
            </text>
            <text x={node.x} y={node.y + 11.8} textAnchor="middle" fill="rgba(245,239,226,0.45)" fontSize="2.3">
              {node.sub}
            </text>
          </g>
        )
      )}
    </svg>
  );
}

function Kicker({ children, tone = 'peacock' }) {
  const tones = { peacock: 'text-peacock-700', ink: 'text-ink', parchment: 'text-parchment/55' };
  return (
    <p className={`text-[11px] font-bold uppercase tracking-[0.18em] ${tones[tone]}`}>{children}</p>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-ink-900 font-sans text-parchment antialiased">
      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-40 border-b border-line-dark bg-ink-900/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
          <Link to="/" className="shrink-0">
            <Brand size="md" tone="light" />
          </Link>

          <nav className="ml-4 hidden items-center gap-6 text-[13px] font-medium text-parchment/70 md:flex">
            {NAV.map((link) => (
              <a key={link.href} href={link.href} className="transition hover:text-parchment">
                {link.label}
              </a>
            ))}
            <Link to="/verify" className="transition hover:text-parchment">
              Verify
            </Link>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/verify"
              className="hidden rounded-full border border-line-dark px-4 py-2 text-[13px] font-semibold text-parchment/85 transition hover:border-parchment/45 hover:text-parchment sm:block"
            >
              Verify a record
            </Link>
            <Link to="/access" className="btn-accent px-5 py-2 text-[13px]">
              Access Dashboard
            </Link>
          </div>
        </div>
      </header>

      {/* -------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden">
        <div className="bg-jali absolute inset-0" aria-hidden="true" />
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{
            background:
              'radial-gradient(48rem 26rem at 82% 8%, rgba(14,110,98,0.30), transparent 62%),' +
              'radial-gradient(32rem 22rem at 8% 92%, rgba(217,154,0,0.12), transparent 62%)',
          }}
        />

        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:pb-24 lg:pt-20">
          <div className="reveal reveal-in">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-parchment/50">
              ApnaRecord · <span className="font-deva normal-case tracking-normal">अपना रिकॉर्ड</span> · live on Sepolia
            </p>

            <h1 className="font-display mt-5 text-[2.6rem] font-bold leading-[1.03] tracking-tight sm:text-5xl lg:text-[3.4rem]">
              Your health records,
              <br />
              owned by you and no one else.
            </h1>

            <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-parchment/65">
              A hospital writes a record to your wallet. Consent becomes a window that closes by
              itself. Anyone can check a file is genuine without asking us.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/access" className="btn-accent px-6 py-3 text-sm">
                Open your dashboard
              </Link>
              <Link
                to="/verify"
                className="rounded-full border border-line-dark px-6 py-3 text-sm font-semibold text-parchment/85 transition hover:border-parchment/45 hover:text-parchment"
              >
                Verify a record — no wallet
              </Link>
            </div>

            <p className="mt-4 flex items-center gap-2 text-xs text-parchment/40">
              <LiveDot tone="marigold" />
              Sign-in is your wallet. The contract decides your role — there is no password here.
            </p>

            {/* Institutional credibility row. Claims a reader can check in one click. */}
            <ul className="mt-7 flex flex-wrap gap-x-2 gap-y-2">
              {TRUST_BADGES.map((badge) => (
                <li
                  key={badge.label}
                  className="rounded-institutional border border-line-dark px-2.5 py-1 text-[11px] font-medium text-parchment/60"
                >
                  {badge.label}
                </li>
              ))}
            </ul>
          </div>

          {/* The product, in the DOM. Not a screenshot, not a 3D blob. */}
          <div className="relative mx-auto w-full max-w-[520px]">
            <div className="rounded-2xl border border-line-dark bg-ink-800/80 p-5 shadow-overlay backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-parchment/40">
                  Consent window · live
                </p>
                <span className="status-expiring !bg-marigold-400/15 !text-marigold-300 !ring-marigold-400/30">
                  <span aria-hidden="true" className="live-dot h-1.5 w-1.5 rounded-full bg-marigold-400" />
                  0:47 left
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                {[
                  { k: 'Record', v: 'Token #1 · MRI scan' },
                  { k: 'Granted to', v: 'Cardiology' },
                  { k: 'Purpose', v: 'Pre-operative review' },
                  { k: 'Expires', v: 'In 47 seconds' },
                ].map((row) => (
                  <div key={row.k} className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-parchment/35">
                      {row.k}
                    </dt>
                    <dd className="mt-0.5 truncate text-[13px] font-medium text-parchment">{row.v}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-5 rounded-xl border border-line-dark bg-ink-950/60 p-3.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-parchment/35">
                  On-chain digest
                </p>
                <p className="mono mt-1 break-all text-[12px] leading-relaxed text-parchment/55">
                  0x9f2c41b7e0a3d8c5f14b6e7a2d90c3f8b1e4a7d6920c5f3b8a1e4d7c0b3f6920
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-parchment/45">
                  The file itself never leaves the browser in plaintext. Only these 32 bytes are
                  anchored.
                </p>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-parchment/45">
                <span className="mono rounded bg-ink-950/60 px-1.5 py-0.5 text-[10px] ring-1 ring-inset ring-line-dark">
                  contract.viewRecord()
                </span>
                <span aria-hidden="true">→</span>
                <span className="text-peacock-300">returns the CID</span>
              </div>
            </div>

            {/* The orbit sits behind the card, so the card reads as the centre. */}
            <div className="pointer-events-none absolute -inset-x-6 -bottom-10 -top-8 -z-10 opacity-70">
              <RouteMap />
            </div>
          </div>
        </div>

        {/* The nine events are the audit trail — a quiet marquee of the vocabulary. */}
        <div className="relative border-t border-line-dark">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-5 py-3.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-parchment/35">
              The audit trail
            </span>
            {NINE_EVENTS.map((name) => (
              <span
                key={name}
                className="mono rounded-institutional border border-line-dark px-1.5 py-0.5 text-[10px] text-parchment/50"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------- paper: exhibits */}
      <section id="exhibits" className="bg-paper text-ink">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
          <Reveal>
            <Kicker>What the contract refuses</Kicker>
            <h2 className="font-display mt-3 max-w-3xl text-3xl font-bold leading-[1.08] tracking-tight sm:text-4xl">
              Three things that fail, on purpose.
            </h2>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-slate-600">
              Most platforms describe permissions in a policy document. Here they are a function
              that reverts, and you can watch each one refuse. The error names below are the actual
              Solidity.
            </p>
          </Reveal>

          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {EXHIBITS.map((exhibit, index) => (
              <Reveal key={exhibit.tag} delay={index * 70}>
                <article className="flex h-full flex-col rounded-2xl border border-line bg-white p-5 shadow-card">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-marigold-700">
                    {exhibit.tag}
                  </p>
                  <h3 className="font-display mt-2 text-lg font-bold leading-snug text-ink">
                    {exhibit.title}
                  </h3>
                  <p className="mt-2 flex-1 text-[13px] leading-relaxed text-slate-600">{exhibit.body}</p>
                  <div className="mt-4 rounded-lg border border-error-200 bg-error-50 px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-error-700/70">
                      Reverts with
                    </p>
                    <p className="mono mt-0.5 text-[11px] font-medium text-error-700">
                      ✕ {exhibit.revert}
                    </p>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>

          <Reveal>
            <div className="mt-8 flex flex-wrap items-center gap-3 rounded-xl border border-peacock-200 bg-peacock-50 px-4 py-3.5">
              <p className="text-[13px] leading-relaxed text-peacock-900">
                <strong>Nothing above needs an account to check.</strong> Verification is a free
                <span className="mono"> view </span> call — no gas, no wallet, no trust in us.
              </p>
              <Link to="/verify" className="btn-primary ml-auto shrink-0">
                Try it on a real record
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* --------------------------------------------------- ink: how it moves */}
      <section id="lifecycle" className="relative overflow-hidden bg-ink-900">
        <div className="bg-jali absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto max-w-6xl px-5 py-16 sm:py-20">
          <Reveal>
            <Kicker tone="parchment">From scan to verification</Kicker>
            <h2 className="font-display mt-3 max-w-2xl text-3xl font-bold leading-[1.08] tracking-tight sm:text-4xl">
              Where the record goes, and who can stop it.
            </h2>
          </Reveal>

          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {[
              { n: '01', t: 'Sealed in the browser', b: 'AES-256-GCM with a key generated in the tab. The server only ever receives ciphertext.' },
              { n: '02', t: 'Digest anchored', b: 'keccak256 of the ciphertext goes on-chain. The file never does.' },
              { n: '03', t: 'Token minted to you', b: 'Hospital IT mints it — and immediately loses the ability to read it.' },
              { n: '04', t: 'You open a window', b: 'One wallet, one record, one expiry. Granted and revoked by you alone.' },
              { n: '05', t: 'Anyone can verify', b: 'Rehash the file, compare the digest, get a verdict. Free and permanent.' },
            ].map((step, index) => (
              <Reveal key={step.n} delay={index * 60}>
                <li className="h-full rounded-2xl border border-line-dark bg-ink-800/60 p-4">
                  <span className="mono text-[10px] font-bold text-marigold-400">{step.n}</span>
                  <p className="mt-2 text-sm font-semibold text-parchment">{step.t}</p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-parchment/55">{step.b}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* --------------------------------------------------- paper: consent */}
      <section id="consent" className="bg-paper text-ink">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <Reveal>
              <Kicker>Consent, taken seriously</Kicker>
              <h2 className="font-display mt-3 text-3xl font-bold leading-[1.08] tracking-tight sm:text-4xl">
                A window, not a checkbox.
              </h2>
              <p className="mt-4 max-w-md text-[15px] leading-relaxed text-slate-600">
                Consent that cannot be taken back is not consent. Every grant here names its
                purpose, its scope and its deadline, and every one of them is revocable by the
                person it belongs to.
              </p>

              <div className="mt-6 rounded-2xl border border-marigold-200 bg-marigold-50 p-4">
                <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-marigold-700">
                  <span aria-hidden="true" className="live-dot h-1.5 w-1.5 rounded-full bg-marigold-400" />
                  The deadline is the contract's
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-marigold-700/90">
                  Grant sixty seconds and the read stops at the sixty-first — no administrator, no
                  cleanup, nothing to remember. Revocation is the same: immediate, public, and
                  visible to the next caller.
                </p>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
                <header className="border-b border-line px-5 py-3.5">
                  <h3 className="text-sm font-semibold text-ink">A grant, decomposed</h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Five fields. Anything less specific is a checkbox wearing a policy's clothes.
                  </p>
                </header>
                <dl>
                  {ARTEFACT.map((row, index) => (
                    <div
                      key={row.k}
                      className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3.5 ${
                        index === ARTEFACT.length - 1 ? '' : 'border-b border-line'
                      }`}
                    >
                      <dt className="w-24 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-peacock-700">
                        {row.k}
                      </dt>
                      <dd className="text-[13px] leading-relaxed text-slate-700">{row.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- ink: two audiences */}
      <section id="limits" className="relative overflow-hidden bg-ink-900">
        <div className="bg-jali absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto max-w-6xl px-5 py-16 sm:py-20">
          <div className="grid gap-8 lg:grid-cols-2">
            <Reveal>
              <div className="h-full rounded-2xl border border-line-dark bg-ink-800/60 p-6">
                <Kicker tone="parchment">If you are a patient</Kicker>
                <h3 className="font-display mt-3 text-xl font-bold text-parchment">
                  You hold the deciding vote.
                </h3>
                <ul className="mt-4 space-y-3 text-[13px] leading-relaxed text-parchment/65">
                  {[
                    'Your records live in a wallet only you can sign with.',
                    'Nobody reads a scan without a window you opened.',
                    'Every access, grant, refusal and expiry is public and permanent.',
                    'Your name is never on the chain — you can erase it whenever you like.',
                  ].map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span aria-hidden="true" className="mt-0.5 text-peacock-300">
                        ✓
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <div className="h-full rounded-2xl border border-line-dark bg-ink-800/60 p-6">
                <Kicker tone="parchment">If you are a hospital or a clinician</Kicker>
                <h3 className="font-display mt-3 text-xl font-bold text-parchment">
                  Fewer places to be wrong.
                </h3>
                <ul className="mt-4 space-y-3 text-[13px] leading-relaxed text-parchment/65">
                  {[
                    'Nothing to breach: the server never holds a usable key.',
                    'Access is checked against the contract on every single call.',
                    'An audit trail you cannot edit, because you never wrote it.',
                    'Break-glass exists for emergencies — capped at an hour, and logged with a reason.',
                  ].map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <span aria-hidden="true" className="mt-0.5 text-peacock-300">
                        ✓
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>

          {/* What we hold / what we do not — designed, not asserted in prose. */}
          <Reveal>
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-line-dark px-5 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-parchment/40">
                  What we hold
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-parchment/60">
                  Encrypted blobs, sealed content keys, and the display names patients choose to
                  publish. That is the entire list.
                </p>
              </div>
              <div className="rounded-xl border border-line-dark px-5 py-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-parchment/40">
                  What we never hold
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-parchment/60">
                  A signing key, a readable record, or the ability to grant access on your behalf.
                  The server has no key to steal and no permission to borrow.
                </p>
              </div>
            </div>
          </Reveal>

          <Reveal>
            <div className="mt-5 rounded-xl border border-warn-200/30 bg-warn-500/10 px-5 py-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-marigold-300">
                Stated plainly
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-parchment/60">
                This is a demo on a testnet, with synthetic data. Records are soulbound, so no
                transfer events exist — deliberately. Key wrapping is handled by the backend today;
                delegating it to a key-management network is the production path, not something
                built. ABDM and DILRMP are alignment targets, not integrations.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* --------------------------------------------------------- final CTA */}
      <section className="border-t border-line-dark bg-ink-950">
        <div className="mx-auto max-w-6xl px-5 py-16 text-center sm:py-20">
          <Reveal>
            <h2 className="font-display mx-auto max-w-2xl text-3xl font-bold leading-[1.08] tracking-tight sm:text-4xl">
              Put your health somewhere you can point at.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-parchment/60">
              Three minutes with the demo walks every role, using real chain state — no wallet, no
              sign-up, nothing installed.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link to="/access" className="btn-accent px-6 py-3 text-sm">
                Open the demo walkthrough
              </Link>
              <Link
                to="/verify"
                className="rounded-full border border-line-dark px-6 py-3 text-sm font-semibold text-parchment/85 transition hover:border-parchment/45 hover:text-parchment"
              >
                Verify a record first
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------ footer */}
      <footer className="border-t border-line-dark bg-ink-950">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-5 px-5 py-8">
          <Brand size="sm" tone="light" devanagari />

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <a
              href={EXPLORER}
              target="_blank"
              rel="noreferrer"
              className="mono text-parchment/45 underline decoration-dotted underline-offset-2 hover:text-parchment/80"
            >
              {CONTRACT_ADDRESS.slice(0, 10)}…{CONTRACT_ADDRESS.slice(-8)}
            </a>
            <span aria-hidden="true" className="text-parchment/20">
              ·
            </span>
            <a
              href={TX_EXPLORER}
              target="_blank"
              rel="noreferrer"
              className="text-parchment/45 underline decoration-dotted underline-offset-2 hover:text-parchment/80"
            >
              Sepolia explorer
            </a>
          </div>

          <nav className="ml-auto flex flex-wrap gap-5 text-[13px] font-medium text-parchment/55">
            {NAV.map((link) => (
              <a key={link.href} href={link.href} className="hover:text-parchment">
                {link.label}
              </a>
            ))}
            <Link to="/verify" className="hover:text-parchment">
              Verify
            </Link>
            <Link to="/access" className="font-semibold text-parchment hover:text-parchment">
              Access Dashboard
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
