import React, { useMemo, useState } from 'react';
import RecordReader from './RecordReader';
import ConsentTimer from './ConsentTimer';
import { Callout, Pill, Status } from './ui';
import { absoluteTime, humanType, relativeTime, shortAddress } from '../lib/format';

/**
 * The patient chart.
 *
 * What a clinician actually needs before reading anything: who this is, what is
 * known about them clinically, which reports exist, which of them can be opened
 * right now, and who else has been looking. A list of tokens answers none of that,
 * which is why a table row is not a chart.
 *
 * The clinical fields are patient-published and off-chain. They are shown, and
 * they are labelled — a blood group typed by a patient is useful context and is
 * not the same kind of fact as a digest anchored on-chain, and blurring those two
 * would be the most dangerous thing this screen could do.
 */
export default function PatientChart({ patient, stats, profile, viewer, nameFor, onOpenConsole }) {
  const [openToken, setOpenToken] = useState(null);

  const records = useMemo(
    () => stats.records.filter((r) => r.patient === patient.address),
    [stats.records, patient.address]
  );

  const consents = useMemo(
    () => stats.consents.filter((c) => c.patient === patient.address),
    [stats.consents, patient.address]
  );

  const requests = useMemo(
    () => (stats.requests || []).filter((r) => r.patient === patient.address),
    [stats.requests, patient.address]
  );

  // Which records THIS wallet may open. The owner can always open their own; a
  // viewer needs a live window. Nothing is inferred from a role name.
  const readable = useMemo(() => {
    const lower = String(viewer || '').toLowerCase();
    const viaConsent = new Set(
      consents.filter((c) => c.active && String(c.viewer).toLowerCase() === lower).map((c) => c.tokenId)
    );
    for (const record of records) {
      if (String(record.patient).toLowerCase() === lower) viaConsent.add(record.tokenId);
    }
    return viaConsent;
  }, [consents, records, viewer]);

  const myWindowFor = (tokenId) =>
    consents.find(
      (c) => c.tokenId === tokenId && String(c.viewer).toLowerCase() === String(viewer).toLowerCase()
    );

  const clinical = [
    { k: 'Blood group', v: profile?.bloodGroup },
    { k: 'Date of birth', v: profile?.dateOfBirth },
    { k: 'Allergies', v: profile?.allergies },
    { k: 'Emergency contact', v: profile?.emergencyContact },
  ];

  const publishedCount = clinical.filter((field) => field.v).length;

  if (openToken) {
    const record = records.find((r) => r.tokenId === openToken);
    return (
      <RecordReader
        tokenId={openToken}
        viewer={viewer}
        record={record}
        onBack={() => setOpenToken(null)}
        backLabel="Back to the chart"
      />
    );
  }

  const identifier = nameFor(patient.address, patient.label) || patient.displayName || patient.label;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- identity */}
      <section className="rounded-lg border border-line bg-white p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-sm font-bold text-ink">{identifier || 'Unnamed patient'}</h3>
          {patient.displayName && (
            <Pill tone="slate">name is off-chain</Pill>
          )}
          {patient.active ? (
            <Status state="active">Identity active</Status>
          ) : (
            <Status state="revoked">Identity deactivated</Status>
          )}
        </div>
        <p className="mono mt-1.5 break-all text-slate-600">{patient.address}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-slate-500">
          On-chain label: <span className="font-medium">{patient.label || 'none'}</span>. The contract
          knows this wallet by its address and that label — never by a name.
        </p>
      </section>

      {/* ---------------------------------------------------------- clinical */}
      <section className="rounded-lg border border-line bg-white p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold text-ink">Clinical summary</h3>
          <Pill tone="slate">patient-published · off-chain</Pill>
          {publishedCount === 0 && <Status state="expired">Nothing published</Status>}
        </div>

        {publishedCount === 0 ? (
          <p className="mt-2 text-[13px] leading-relaxed text-slate-500">
            This patient has not published a clinical summary. That is their choice and it is
            deliberate: these fields live off-chain so they can be corrected or erased, which means
            they are never guaranteed to be present.
          </p>
        ) : (
          <dl className="mt-3 grid gap-x-5 gap-y-3 sm:grid-cols-2">
            {clinical.map((field) => (
              <div key={field.k} className="min-w-0">
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {field.k}
                </dt>
                <dd
                  className={`text-xs ${
                    field.v ? 'text-slate-700' : 'italic text-slate-400'
                  }`}
                >
                  {field.v || 'not published'}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <p className="mt-3 border-t border-line pt-2.5 text-[13px] leading-relaxed text-slate-500">
          Self-reported and therefore context, not evidence. Nothing here is anchored on-chain or
          signed by a clinician. The digest on each report below is the only thing in this panel that
          is cryptographically backed.
        </p>
      </section>

      {/* ----------------------------------------------------------- reports */}
      <section className="rounded-lg border border-line bg-white p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold text-ink">
            Reports held for this patient ({records.length})
          </h3>
          <Pill tone={readable.size > 0 ? 'peacock' : 'slate'}>
            {readable.size} openable by you
          </Pill>
        </div>

        {records.length === 0 ? (
          <p className="mt-2 text-[11px] text-slate-500">
            No records have been issued to this wallet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {records.map((record) => {
              const canOpen = readable.has(record.tokenId);
              const window = myWindowFor(record.tokenId);
              return (
                <li
                  key={record.tokenId}
                  className={`rounded-lg border p-3 ${
                    canOpen ? 'border-peacock-200 bg-peacock-50/40' : 'border-line'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone="peacock">#{record.tokenId}</Pill>
                    <span className="text-xs font-semibold text-ink">
                      {humanType(record.recordType)}
                    </span>
                    {canOpen ? (
                      <Status state="active">Openable now</Status>
                    ) : (
                      <Status state="denied">No consent</Status>
                    )}
                    {window?.active && (
                      <span className="ml-auto">
                        <ConsentTimer expiresAt={window.expiresAt} showAbsolute={false} label="Ends" />
                      </span>
                    )}
                  </div>

                  <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-[10px] uppercase tracking-wide text-slate-400">Issued</dt>
                      <dd className="text-[11px] text-slate-600">
                        {record.mintedAt
                          ? `${absoluteTime(record.mintedAt)} · ${relativeTime(record.mintedAt)}`
                          : `block ${record.mintedAtBlock}`}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[10px] uppercase tracking-wide text-slate-400">
                        Ordered by
                      </dt>
                      <dd className="text-[11px] text-slate-600">
                        {record.orderedByLabel || (record.orderedBy ? shortAddress(record.orderedBy) : '—')}
                        {record.requestId ? (
                          <span className="text-slate-400"> · request #{record.requestId}</span>
                        ) : null}
                      </dd>
                    </div>
                  </dl>

                  <p className="mono mt-2 truncate text-[10px] text-slate-400" title={record.recordHash}>
                    {record.recordHash}
                  </p>

                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenToken(record.tokenId)}
                      className={canOpen ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
                    >
                      {canOpen ? 'Open report' : 'Try to open (should be refused)'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* -------------------------------------------------------- access log */}
      <section className="rounded-lg border border-line bg-white p-3.5">
        <h3 className="text-xs font-semibold text-ink">
          Consent granted on these records ({consents.length})
        </h3>
        {consents.length === 0 ? (
          <p className="mt-2 text-[11px] text-slate-500">
            No window has ever been granted on this patient's records.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {consents.map((consent) => (
              <li
                key={`${consent.tokenId}-${consent.viewer}`}
                className={`rounded-lg border px-3 py-2 ${
                  consent.active ? 'border-peacock-200 bg-peacock-50/30' : 'border-line'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="slate">#{consent.tokenId}</Pill>
                  <span className="text-xs font-medium text-ink">
                    {consent.viewerLabel || shortAddress(consent.viewer)}
                  </span>
                  {consent.grantedVia === 'emergency' ? (
                    <Status state="pending">break-glass</Status>
                  ) : (
                    <Status state={consent.active ? 'active' : 'expired'}>
                      {consent.active ? 'Active' : 'Lapsed'}
                    </Status>
                  )}
                  {consent.revoked && <Status state="revoked">Revoked</Status>}
                  <span className="ml-auto">
                    <ConsentTimer
                      expiresAt={consent.active ? consent.expiresAt : undefined}
                      showAbsolute={false}
                    />
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Authorised by the {consent.authorisedBy}
                  {consent.grantedAt ? ` on ${absoluteTime(consent.grantedAt)}` : ''}
                  {consent.revokedAt ? ` · revoked ${absoluteTime(consent.revokedAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------- requests */}
      {requests.length > 0 && (
        <section className="rounded-lg border border-line bg-white p-3.5">
          <h3 className="text-xs font-semibold text-ink">
            Requests made for this patient ({requests.length})
          </h3>
          <ul className="mt-3 space-y-2">
            {requests.map((request) => (
              <li
                key={request.requestId}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
              >
                <Pill tone="slate">#{request.requestId}</Pill>
                <span className="text-xs text-slate-700">{humanType(request.recordType)}</span>
                <span className="text-[11px] text-slate-500">
                  by {request.requesterLabel || shortAddress(request.requester)}
                </span>
                {request.status === 'open' ? (
                  <Status state="pending">Awaiting an admin</Status>
                ) : (
                  <Status state="active">Issued as token #{request.fulfilledByTokenId}</Status>
                )}
                <span className="ml-auto text-[11px] text-slate-400">
                  {request.requestedAt ? relativeTime(request.requestedAt) : `block ${request.blockNumber}`}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-[13px] leading-relaxed text-slate-500">
            The contract records a request as an event and stores no status, so whether one has been
            answered is derived by matching the request against later mints for the same patient and
            record type. It is a sound reading, not a chain-level fact.
          </p>
        </section>
      )}

      {onOpenConsole && (
        <button type="button" onClick={onOpenConsole} className="btn-secondary w-full">
          Open the full console for this patient
        </button>
      )}
    </div>
  );
}

/** A compact, consistent token reference for tables and lists. */
export function RecordRef({ record, className = '' }) {
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      <Pill tone="slate">#{record.tokenId}</Pill>
      <span className="text-xs font-medium text-ink">{humanType(record.recordType)}</span>
      {record.mintedAt && (
        <span className="text-[10px] text-slate-400">{absoluteTime(record.mintedAt, { withDate: false })}</span>
      )}
    </span>
  );
}
