import React from 'react';

// The record lifecycle, as a real diagram rather than prose.
//
// Layout is the same shape the architecture drawing uses: an issue path running
// left to right, and three decision points with a red exit. The red exits are the
// argument — they are not error handling, they are the design working.

const STEPS = [
  {
    n: 1,
    title: 'Identity registered',
    detail: 'Admin writes it on-chain. The DID is derived from the key as did:ethr:<chain>:<address>.',
    actor: 'Admin',
  },
  {
    n: 2,
    title: 'Upload and encrypt',
    detail: 'The browser seals the file with its own AES-256-GCM key before anything leaves the tab.',
    actor: 'Manager',
  },
  {
    n: 3,
    title: 'Digest anchored',
    detail: 'Only keccak256 of the ciphertext goes on-chain. The file itself never does.',
    actor: 'Manager',
  },
  {
    n: 4,
    title: 'Will the admin mint?',
    detail: 'requestRecord by the clinician, then mintRecord by the admin.',
    actor: 'Admin',
    decision: {
      question: 'DEFAULT_ADMIN_ROLE held?',
      no: 'AccessControl revert for a missing role — no token exists',
      yes: 'Token minted to the patient, not the hospital',
    },
  },
  {
    n: 5,
    title: 'Consent window opens',
    detail: 'The patient — never the hospital — grants time-boxed access to a named viewer.',
    actor: 'Patient',
  },
  {
    n: 6,
    title: 'Consent valid?',
    detail: 'Every read re-checks this in the contract. There is no cached permission.',
    actor: 'Contract',
    decision: {
      question: 'canAccess(tokenId, viewer)',
      no: 'Expired / AccessDenied revert — the read is refused',
      yes: 'The contract releases the file location',
    },
  },
  {
    n: 7,
    title: 'Digest matches?',
    detail: 'Rehash the file and compare it with the on-chain digest. Free and open to anyone.',
    actor: 'Anyone',
    decision: {
      question: 'keccak256(file) == on-chain digest',
      no: 'Tampered — the mismatch is public and undeniable',
      yes: 'Authentic',
    },
  },
];

const ACTOR_TONE = {
  Admin: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
  Manager: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
  Patient: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
  Contract: 'bg-slate-100 text-slate-600 ring-slate-200',
  Anyone: 'bg-marigold-50 text-marigold-700 ring-marigold-200',
};

function Step({ step }) {
  return (
    <div className="relative min-w-0">
      <div
        className={`h-full rounded-xl border bg-white p-3 shadow-card ${
          step.decision ? 'border-marigold-200' : 'border-line'
        }`}
      >
        <div className="mb-1.5 flex items-center gap-2">
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
              step.decision ? 'bg-marigold-50 text-marigold-700' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {step.n}
          </span>
          <span
            className={`rounded-institutional px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1 ring-inset ${
              ACTOR_TONE[step.actor] || ACTOR_TONE.Contract
            }`}
          >
            {step.actor}
          </span>
        </div>

        <p className="break-words text-xs font-semibold leading-snug text-ink">{step.title}</p>
        <p className="mt-1 break-words text-[13px] leading-relaxed text-slate-500">{step.detail}</p>

        {step.decision && (
          <div className="mt-2 space-y-1">
            <p className="mono break-words text-[10px] text-marigold-700">{step.decision.question}</p>
            <p className="break-words rounded border border-error-200 bg-error-50 px-1.5 py-1 text-[12px] leading-snug text-error-700">
              ✕ {step.decision.no}
            </p>
            <p className="break-words rounded border border-success-200 bg-success-50 px-1.5 py-1 text-[12px] leading-snug text-success-700">
              ✓ {step.decision.yes}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LifecycleFlow({ compact = false }) {
  const steps = compact ? STEPS.filter((s) => [2, 4, 6].includes(s.n)) : STEPS;

  return (
    <div>
      {/* Seven columns is the shape the diagram wants — the path reads left to right — but
          at `xl` that leaves each card about 150px, which is narrower than several of the
          strings it has to hold (`did:ethr:<chain>:<address>`, `canAccess(tokenId, viewer)`).
          Forcing the full row there is what made them spill. At 2xl there is room for the
          seven, so the path only collapses to a grid when it genuinely cannot fit. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
        {steps.map((step) => (
          <Step key={step.n} step={step} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-slate-50 px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          The nine events are the audit trail
        </span>
        {[
          'IdentityCreated',
          'RecordRequested',
          'RecordMinted',
          'Locked',
          'AccessGranted',
          'AccessRevoked',
          'EmergencyAccessUsed',
          'RecordRevoked',
          'RoleGranted',
        ].map((name) => (
          <span
            key={name}
            className="mono rounded-institutional bg-white px-1.5 py-0.5 text-[9px] text-slate-600 ring-1 ring-inset ring-line"
          >
            {name}
          </span>
        ))}
        <span className="text-[10px] italic text-slate-500">
          Nobody maintains a log file. The chain is the log.
        </span>
      </div>
    </div>
  );
}
