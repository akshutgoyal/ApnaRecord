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

// The same lifecycle, from each role's seat.
//
// The seven steps above are the whole journey and they belong on the public page, where
// nobody is signed in. Inside a console they are the wrong diagram: an auditor scrolling
// past "grant a window" reads about a job they cannot do, and a patient reading about
// mintRecord reads about a thing that is not theirs to do.
//
// So each role gets the arc it actually walks, in its own verbs, ending on the boundary
// it cannot cross. The exclusions are the point -- they are what makes the wall real
// rather than a rule somebody has to remember.
const FLOWS = {
  admin: [
    {
      n: 1,
      title: 'Register an identity',
      detail: 'You write it on-chain. The DID derives from the key as did:ethr:<chain>:<address>, so nobody issues one.',
      actor: 'Admin',
      decision: {
        question: 'DEFAULT_ADMIN_ROLE held?',
        no: 'AccessControl revert — nothing is written',
        yes: 'Identity recorded, and you may label it',
      },
    },
    {
      n: 2,
      title: 'Mint a record',
      detail: 'A clinician requests, you mint. The token goes to the patient, never to the practice that asked for it.',
      actor: 'Admin',
    },
    {
      n: 3,
      title: 'Revoke a record',
      detail: 'You can burn it. You still cannot read it — minting is not a key to the file.',
      actor: 'Admin',
      decision: {
        question: 'Can the minter read what they minted?',
        no: 'canAccess is false for you too, whatever your role',
        yes: 'Only the patient can open that door',
      },
    },
  ],
  doctor: [
    {
      n: 1,
      title: 'Request a record',
      detail: 'requestRecord names the patient. The admin decides whether to mint; you cannot mint for yourself.',
      actor: 'Doctor',
    },
    {
      n: 2,
      title: 'Read while consent holds',
      detail: 'The patient granted you a window. Every read re-checks it against the contract — there is no cached permission.',
      actor: 'Contract',
      decision: {
        question: 'canAccess(tokenId, viewer)',
        no: 'AccessDenied revert — the read is refused',
        yes: 'The contract releases the file location',
      },
    },
    {
      n: 3,
      title: 'Break glass, if it is urgent',
      detail: 'One hour, one record, permanently on the log. It is not an override; it is a recorded exception.',
      actor: 'Doctor',
    },
    {
      n: 4,
      title: 'The window closes',
      detail: 'Access ends on its own. The request that worked a minute ago is refused, and nobody had to revoke anything.',
      actor: 'Contract',
    },
  ],
  hospital: [
    {
      n: 1,
      title: 'Link a patient',
      detail: 'With their consent. The link is what lets you act for them, and it is theirs to hold.',
      actor: 'Hospital',
      decision: {
        question: 'PatientLinked held?',
        no: 'You cannot register or mint for someone you are not linked to',
        yes: 'You may act for that patient — and only that one',
      },
    },
    {
      n: 2,
      title: 'Mint for a linked patient',
      detail: 'Your facility is recorded as the origin. Records you mint land with the patient, not in a hospital folder.',
      actor: 'Hospital',
    },
    {
      n: 3,
      title: 'Register your own staff',
      detail: 'A facility may register identities inside itself. You still never receive a patient file.',
      actor: 'Hospital',
      decision: {
        question: 'Can the facility read the record it minted?',
        no: 'facilityPatient gates the action, not the content',
        yes: 'The patient decides who sees it',
      },
    },
  ],
  patient: [
    {
      n: 1,
      title: 'You own it',
      detail: 'The token is minted to your address, not to the hospital that uploaded it. Nobody else can move it.',
      actor: 'Patient',
    },
    {
      n: 2,
      title: 'Grant a window',
      detail: 'A named viewer, and a duration you choose. Only you can open this door — not the admin who minted it.',
      actor: 'Patient',
      decision: {
        question: 'Who can grant access to your record?',
        no: 'Not the hospital, not the doctor, not the platform',
        yes: 'You, from your own wallet, for as long as you say',
      },
    },
    {
      n: 3,
      title: 'Revoke at will',
      detail: 'End it early and the same request is refused on the next read. The window also closes on its own.',
      actor: 'Patient',
      decision: {
        question: 'Can you give the record away?',
        no: 'It is soulbound — no transfer function exists',
        yes: 'You can only decide who may read it, and for how long',
      },
    },
  ],
  auditor: [
    {
      n: 1,
      title: 'Read the facts',
      detail: 'Hash, type, time and owner. Everything the chain holds about the record, in one call.',
      actor: 'Auditor',
    },
    {
      n: 2,
      title: 'Read the whole log',
      detail: 'Every event this contract has ever emitted, newest first. Nobody maintains it, and nobody can edit it.',
      actor: 'Auditor',
    },
    {
      n: 3,
      title: 'Verify without access',
      detail: 'Rehash a file and compare it with the on-chain digest. Free, needs no wallet and no permission.',
      actor: 'Anyone',
      decision: {
        question: 'Does the auditor ever receive the file location?',
        no: 'By construction — the role exists to check, not to see',
        yes: 'That would make the audit path the hole in the privacy model',
      },
    },
  ],
};

const ACTOR_TONE = {
  Admin: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
  Manager: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
  Patient: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
  Contract: 'bg-slate-100 text-slate-600 ring-slate-200',
  Doctor: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
  Hospital: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
  Auditor: 'bg-peacock-50 text-peacock-700 ring-peacock-200',
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

export default function LifecycleFlow({ role = null, compact = false }) {
  const owned = (role && FLOWS[role]) || null;
  const full = owned || STEPS;
  // The public seven get filtered for the narrow column. A role's own arc is already
  // short, and cutting it would remove the boundary it ends on.
  const steps = compact && !owned ? full.filter((s) => [2, 4, 6].includes(s.n)) : full;

  return (
    <div>
      {/* Seven columns is the shape the diagram wants — the path reads left to right — but
          at `xl` that leaves each card about 150px, which is narrower than several of the
          strings it has to hold (`did:ethr:<chain>:<address>`, `canAccess(tokenId, viewer)`).
          Forcing the full row there is what made them spill. At 2xl there is room for the
          seven, so the path only collapses to a grid when it genuinely cannot fit. */}
      <div
        className={`grid gap-3 sm:grid-cols-2 ${
          owned ? 'lg:grid-cols-3' : 'lg:grid-cols-4 2xl:grid-cols-7'
        }`}
      >
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
