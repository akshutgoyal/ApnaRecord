import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { isAddress } from 'ethers';
import { useChain } from '../chain';
import { decryptRecord, fromBase64, formatBytes } from '../crypto';
import { chainEvents, listRecords, releaseFile, recordRequest } from '../services/api';
import { requestMessage } from '../lib/wireMessages';
import { useTx } from '../hooks/useTx';
import AddressInput from '../components/AddressInput';
import ConsentTimer from '../components/ConsentTimer';
import {
  Busy,
  Callout,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Pill,
  SkeletonRows,
  Status,
} from '../components/ui';
import RecordPreview from '../components/RecordPreview';
import { previewOf, looksLikeText } from '../lib/preview';

const RECORD_TYPES = ['MRI_SCAN', 'BLOOD_PANEL', 'XRAY', 'DISCHARGE_SUMMARY'];

export default function Doctor() {
  const { account, roles, readContract, writeAs, signRead, signMessage, refresh } = useChain();
  const { run, isBusy } = useTx({ onDone: useCallback(() => refresh(), [refresh]) });

  const [records, setRecords] = useState([]);
  const [accessMap, setAccessMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [request, setRequest] = useState({ patient: '', recordType: 'MRI_SCAN' });
  const [breakGlass, setBreakGlass] = useState({ tokenId: '' });
  const [viewing, setViewing] = useState(null);

  const isManager = roles.manager;

  /** Every record on the contract, annotated with whether THIS wallet may read it. */
  const load = useCallback(async () => {
    if (!account) {
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { records: all } = await listRecords();
      const contract = await readContract();
      const access = {};
      for (const record of all) {
        try {
          // The contract answers, not the UI.
          access[record.tokenId] = contract
            ? await contract.canAccess(record.tokenId, account)
            : false;
        } catch {
          access[record.tokenId] = false;
        }
      }
      setAccessMap(access);
      setRecords(all);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [account, readContract]);

  useEffect(() => {
    load();
  }, [load]);

  const readable = useMemo(
    () => records.filter((record) => accessMap[record.tokenId]),
    [records, accessMap]
  );

  const requestRecord = () =>
    run(
      'requestRecord',
      async () => {
        if (!isAddress(request.patient)) throw new Error('A valid patient address is required.');
        // The chain anchors only (requestId, requester). The patient and the
        // record type travel signed to the server, which is the only place
        // they are stored — see POST /requests.
        const tx = await writeAs('requestRecord', []);
        const receipt = await tx.wait();
        const reader = await readContract();
        let requestId = null;
        for (const log of receipt.logs || []) {
          try {
            const parsed = reader.interface.parseLog(log);
            if (parsed?.name === 'RecordRequested') {
              requestId = Number(parsed.args.requestId);
              break;
            }
          } catch {
            /* not our event */
          }
        }
        if (!Number.isInteger(requestId) || requestId <= 0) {
          throw new Error('The request landed but its id could not be read. Find it in the event log and file the contents from there.');
        }
        const timestamp = Date.now();
        const signature = await signMessage(
          requestMessage(requestId, request.patient, request.recordType, timestamp)
        );
        await recordRequest({
          requestId,
          patient: request.patient,
          recordType: request.recordType,
          timestamp,
          signature,
        });
        setRequest({ patient: '', recordType: 'MRI_SCAN' });
      },
      {
        successDetail: 'RecordRequested recorded. The lab requests — the admin decides whether to mint.',
      }
    );

  const emergencyAccess = () =>
    run(
      'emergencyAccess',
      async () => {
        const tokenId = Number(breakGlass.tokenId);
        if (!Number.isInteger(tokenId) || tokenId <= 0) throw new Error('Enter a token ID.');
        // The justification is NOT on-chain any more: it was free text on a
        // permanent public log. The event records viewer and expiry; the reason
        // is stated to the patient out of band.
        const tx = await writeAs('emergencyAccess', [tokenId, account]);
        await tx.wait();
        setBreakGlass({ tokenId: '' });
        await load();
      },
      {
        successDetail:
          'One hour, one record, and the access is permanently on-chain. Consent was bypassed by design.',
      }
    );

  const openRecord = (tokenId) =>
    run(`Open record #${tokenId}`, async () => {
      // Prove we are the viewer before asking. The release endpoint refuses an
      // unsigned request outright, which is the point of the change.
      const proof = await signRead(tokenId, account);
      const released = await releaseFile(tokenId, account, proof);
      // Decrypt to BYTES, and only turn them into a string when they are a string.
      //
      // This is the check the patient screen was missing and the reader already had:
      // `TextDecoder` never throws on a PNG, it emits replacement characters. The old
      // `plaintext` was therefore always truthy, the "not readable here" branch below
      // never ran, and a clinician opening a scan got mojibake where the image belonged.
      // The doctor's console was the third copy of this code and the last to be fixed.
      let bytes = null;
      let text = null;
      try {
        const plain = await decryptRecord(fromBase64(released.ciphertext), released.contentKey);
        // `bytes` is the PLAINTEXT. Keeping the ciphertext here was the bug: the declared
        // MIME type is image/png, so previewOf classified the ciphertext as an image and
        // the <img> was handed bytes that are not a PNG. It failed to decode and the
        // browser drew the alt text -- which is why the record showed its own filename
        // where the scan should be.
        bytes = plain;
        text = looksLikeText(plain) ? new TextDecoder().decode(plain) : null;
      } catch {
        bytes = null;
        text = null;
      }
      // The expiry is not readable from any mapping -- the consent record is private, so
      // `canAccess` can only answer open-or-not. The AccessGranted event carries it, and
      // events are public, which is how the patient's screen shows a real countdown.
      //
      // Without this the card passed `undefined` and ConsentTimer rendered "Consent: none"
      // on a record whose consent was very much live -- a wrong answer to the question the
      // card exists to answer.
      let expiresAt = null;
      try {
        const { events } = await chainEvents({ limit: 200 });
        const grant = (events || []).find(
          (e) =>
            e.name === 'AccessGranted' &&
            Number(e.args?.tokenId) === Number(tokenId) &&
            String(e.args?.viewer).toLowerCase() === String(account).toLowerCase()
        );
        if (grant?.args?.expiresAt) expiresAt = Number(grant.args.expiresAt);
      } catch {
        // No timer rather than a wrong one. The release itself already proved the window
        // is open; only its end is unknown.
        expiresAt = null;
      }

      setViewing({
        ...released,
        bytes,
        text,
        expiresAt,
        byteLength: fromBase64(released.ciphertext).length,
      });
      // No expiry re-read: the consent mapping is private, so `canAccess` can
      // only answer open-or-not — and the release succeeding already answered it.
      await load();
    });

  if (!account) {
    return (
      <>
        <PageHeader kicker="Manager · Doctor / lab" title="Records console" />
        <EmptyState
          variant="blocked"
          title="Connect a wallet first"
          hint="This console reads your role from the contract. Switch MetaMask to the Cardiology account to act as the doctor."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        kicker="Manager · Doctor / lab"
        title="Records & requests"
        lead="Request records, read the ones the patient has opened to you, and break glass when you must. Requesting is not minting — the admin decides whether a record comes into existence."
        aside={
          <button type="button" onClick={load} className="btn-secondary">
            Refresh
          </button>
        }
      />

      {!isManager && (
        <Callout tone="warn" className="mb-5" title="This wallet does not hold MANAGER_ROLE">
          Request and break-glass will revert. That is the contract refusing, and it is worth watching
          once — a modified frontend cannot talk its way past it.
        </Callout>
      )}

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card title="Request a record" subtitle="RecordRequested is an event the admin can act on.">
          <div className="space-y-3">
            <AddressInput
              label="Patient address"
              value={request.patient}
              onChange={(value) => setRequest((current) => ({ ...current, patient: value }))}
            />
            <Field label="Record type">
              <div className="flex flex-wrap gap-1.5">
                {RECORD_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={request.recordType === type}
                    onClick={() => setRequest((current) => ({ ...current, recordType: type }))}
                    className={`rounded-institutional border px-2.5 py-1 text-[11px] font-medium transition ${
                      request.recordType === type
                        ? 'border-peacock-300 bg-peacock-50 text-peacock-700'
                        : 'border-line bg-slate-50 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </Field>
            <button
              type="button"
              onClick={requestRecord}
              disabled={isBusy('requestRecord')}
              className="btn-primary w-full"
            >
              {isBusy('requestRecord') ? <Busy label="Confirming…" /> : 'requestRecord'}
            </button>
          </div>
        </Card>

        <Card
          tone="warn"
          title="Emergency break-glass"
          subtitle="Bypasses consent by design. One hour, one record, permanently logged."
        >
          <div className="space-y-3">
            <Field label="Token ID">
              <input
                className="input"
                value={breakGlass.tokenId}
                onChange={(event) =>
                  setBreakGlass((current) => ({
                    ...current,
                    tokenId: event.target.value.replace(/\D/g, ''),
                  }))
                }
                placeholder="1"
                inputMode="numeric"
              />
            </Field>
            <button
              type="button"
              onClick={emergencyAccess}
              disabled={isBusy('emergencyAccess')}
              className="btn-secondary w-full border-warn-200 bg-white text-warn-700 hover:bg-warn-50"
            >
              {isBusy('emergencyAccess') ? <Busy label="Confirming…" /> : 'emergencyAccess'}
            </button>
            <p className="text-[13px] leading-relaxed text-slate-600">
              This is the honest exception to patient control. It is capped at one hour and the
              EmergencyAccessUsed event names the record and the clinician, so it is auditable even
              though it is not based on consent. No reason text goes on-chain — state it to the
              patient out of band.
            </p>
          </div>
        </Card>
      </div>

      <Card
        title="Records you may currently read"
        subtitle="Access is checked against the contract per record — never assumed from a role name."
        right={
          <Pill tone={readable.length > 0 ? 'peacock' : 'slate'}>
            {readable.length} readable of {records.length}
          </Pill>
        }
      >
        {loading && records.length === 0 && <SkeletonRows rows={3} columns={3} />}

        {!loading && records.length === 0 && (
          <EmptyState title="No records on this contract" hint="An admin needs to mint one first." />
        )}

        {records.length > 0 && (
          <ul className="space-y-3">
            {records.map((record) => {
              const allowed = accessMap[record.tokenId];
              return (
                <li
                  key={record.tokenId}
                  className={`rounded-lg border p-3.5 ${
                    allowed ? 'border-peacock-200 bg-peacock-50/40' : 'border-line bg-white'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone="slate">token #{record.tokenId}</Pill>
                    <span className="text-xs font-semibold text-ink">{record.recordType}</span>
                    {record.locked && <Status state="expired">soulbound</Status>}
                    <span className="ml-auto">
                      {allowed ? (
                        <Status state="active" />
                      ) : (
                        <Status state="denied">No consent</Status>
                      )}
                    </span>
                  </div>

                  <p className="mono mt-1.5 truncate text-slate-500">Digest {record.recordHash}</p>
                  <p className="mono mt-0.5 truncate text-slate-400">Owner {record.patient}</p>

                  <div className="mt-2.5">
                    <button
                      type="button"
                      onClick={() => openRecord(record.tokenId)}
                      disabled={isBusy(`Open record #${record.tokenId}`)}
                      className={allowed ? 'btn-primary' : 'btn-secondary'}
                    >
                      {isBusy(`Open record #${record.tokenId}`) ? (
                        <Busy label="Asking the contract…" />
                      ) : allowed ? (
                        'Open record'
                      ) : (
                        'Try anyway (should be refused)'
                      )}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {readable.length === 0 && records.length > 0 && (
          <Callout tone="info" className="mt-3">
            You hold no active consent on any record right now. The patient can open a window from
            the Patient console — and the contract will close it again automatically.
          </Callout>
        )}
      </Card>

      {viewing && <ReleasedRecord record={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function ReleasedRecord({ record, onClose }) {
  return (
    <Card
      className="mt-5"
      tone="ok"
      title={`Record #${record.tokenId} released by the contract`}
      subtitle={`The gate returned: ${record.checkedBy}`}
      right={
        <button type="button" onClick={onClose} className="btn-ghost">
          Close
        </button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ConsentTimer expiresAt={record.expiresAt} label="Consent" />
        <Pill tone="slate">{record.recordType}</Pill>
        <Pill tone="slate">{formatBytes(record.byteLength)} ciphertext</Pill>
      </div>

      {record.bytes && previewOf(record.mimeType, record.bytes) ? (
        <RecordPreview bytes={record.bytes} mimeType={record.mimeType} fileName={record.fileName} />
      ) : record.text ? (
        <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-white p-3.5 text-xs leading-relaxed text-slate-700">
          {record.text}
        </pre>
      ) : (
        <Callout tone="warn" title="Released, but not displayable here">
          {record.bytes
            ? 'The bytes decrypted cleanly, but a browser cannot show this format — Word documents and the like. Use the download below; it opens in whatever handles the type.'
            : 'The bytes arrived but could not be decrypted — this record was encrypted with a different key. The digest can still be verified on the Verify page.'}
        </Callout>
      )}

      <p className="mt-3 text-[13px] leading-relaxed text-slate-500">
        You received this because the contract ran <span className="mono">viewRecord</span> as your
        address and it did not revert. Revoke the consent window and this same request returns
        AccessDenied instead.
      </p>
    </Card>
  );
}
