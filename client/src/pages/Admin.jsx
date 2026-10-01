import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isAddress } from 'ethers';
import { useChain, describeError } from '../chain';
import { encryptRecord, formatBytes, toBase64 } from '../crypto';
import { chainIdentities, chainEvents, storeRecord, recordIdentity, recordFacility } from '../services/api';
import { storeMessage, identityMessage, facilityMessage } from '../lib/wireMessages';
import { TX_EXPLORER } from '../contract';
import { useTx } from '../hooks/useTx';
import { useToast } from '../components/Toast';
import AddressInput from '../components/AddressInput';
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

const RECORD_TYPES = ['MRI_SCAN', 'BLOOD_PANEL', 'XRAY', 'DISCHARGE_SUMMARY', 'PRESCRIPTION'];

export default function Admin() {
  const { account, roles, readContract, writeAs, simulateAs, signMessage, refresh } = useChain();
  const toast = useToast();
  const onDone = useCallback(() => refresh(), [refresh]);
  const { run, isBusy } = useTx({ onDone });

  const [identities, setIdentities] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [newIdentity, setNewIdentity] = useState({ address: '', label: '', facility: '' });
  const [roleGrant, setRoleGrant] = useState({ address: '', role: 'MANAGER_ROLE' });
  const [newFacility, setNewFacility] = useState({ it: '', name: '' });
  const [mint, setMint] = useState({ patient: '', recordType: 'MRI_SCAN', file: null });
  const [revokeId, setRevokeId] = useState('');
  const [searchParams] = useSearchParams();

  // A request in the dashboard's queue links straight here with the patient and
  // record type already chosen. Re-typing a 42-character address that the system
  // already knows is how transcription errors get into medical records.
  const handoffPatient = searchParams.get('patient') || '';
  const handoffType = searchParams.get('type') || '';

  useEffect(() => {
    if (!handoffPatient && !handoffType) return;
    setMint((current) => ({
      ...current,
      patient: handoffPatient || current.patient,
      recordType: handoffType || current.recordType,
    }));
  }, [handoffPatient, handoffType]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [identityResult, eventResult] = await Promise.all([
        chainIdentities(),
        chainEvents({ limit: 40 }),
      ]);
      setIdentities(identityResult.identities || []);
      setEvents(eventResult.events || []);
    } catch (error) {
      setLoadError(describeError(error).detail || error.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const isAdmin = roles.admin;

  // ------------------------------------------------------------- actions

  const createIdentity = () =>
    run(
      'Register identity',
      async () => {
        if (!isAddress(newIdentity.address)) throw new Error('A valid address is required.');
        if (!newIdentity.label.trim()) throw new Error('A label is required.');
        const facility =
          newIdentity.facility.trim() !== '' ? newIdentity.facility.trim() : '';
        if (facility && !isAddress(facility)) throw new Error('Not a valid facility address.');
        // Staff carry the caller's facility; a patient is global (empty facility).
        const tx = await writeAs('createIdentity', [newIdentity.address, facility || '0x0000000000000000000000000000000000000000']);
        await tx.wait();
        // The label lives off-chain now: the event carries no name.
        const timestamp = Date.now();
        const signature = await signMessage(
          identityMessage(newIdentity.address, newIdentity.label.trim(), facility, timestamp)
        );
        await recordIdentity({
          account: newIdentity.address,
          label: newIdentity.label.trim(),
          facility,
          timestamp,
          signature,
        });
        setNewIdentity({ address: '', label: '', facility: '' });
        await load();
      },
      { successDetail: 'IdentityCreated is now a permanent, public event. The label was recorded off-chain.' }
    );

  const createFacility = () =>
    run(
      'Register facility',
      async () => {
        if (!isAddress(newFacility.it)) throw new Error('A valid hospital IT address is required.');
        if (!newFacility.name.trim()) throw new Error('A facility name is required.');
        const tx = await writeAs('createFacility', [newFacility.it]);
        await tx.wait();
        const timestamp = Date.now();
        const signature = await signMessage(
          facilityMessage(newFacility.it, newFacility.name.trim(), timestamp)
        );
        await recordFacility({ it: newFacility.it, name: newFacility.name.trim(), timestamp, signature });
        setNewFacility({ it: '', name: '' });
        await load();
      },
      { successDetail: 'FacilityCreated is on-chain; the name lives in the directory.' }
    );

  const grantRole = () =>
    run(
      'Grant role',
      async () => {
        if (!isAddress(roleGrant.address)) throw new Error('A valid address is required.');
        // The role constants are READS, so they come from a read contract. They used to
        // be read off the write contract, which worked only while the write contract was
        // also the caller — it is not the caller any more.
        const reader = await readContract();
        const roleValue =
          roleGrant.role === 'MANAGER_ROLE'
            ? await reader.MANAGER_ROLE()
            : roleGrant.role === 'HOSPITAL_ROLE'
              ? await reader.HOSPITAL_ROLE()
              : await reader.AUDITOR_ROLE();
        const tx = await writeAs('grantRole', [roleValue, roleGrant.address]);
        await tx.wait();
        setRoleGrant((current) => ({ ...current, address: '' }));
        await load();
      },
      { successDetail: 'RoleGranted is recorded on-chain and the wallet can now use that console.' }
    );

  const mintRecord = () =>
    run(
      'Mint record',
      async () => {
        if (!isAddress(mint.patient)) throw new Error('A valid patient address is required.');
        if (!mint.file) throw new Error('Choose a file to attach.');

        // 1. Encrypt HERE. The server receives ciphertext, never the document.
        const buffer = await mint.file.arrayBuffer();
        const { payload, digest, contentKey } = await encryptRecord(buffer);

        // 2. Store the bytes first. If this fails we abort BEFORE minting, because
        //    a token whose bytes nobody holds is worse than no token at all.
        const contract = await readContract();
        const tokenId = Number(await contract.nextTokenId());

        // The upload is signed. The token does not exist yet — it is about to be
        // minted — so the server cannot check its owner; it checks that the signer
        // holds the on-chain role that permits minting, and that this is the token
        // actually next in line. The digest is in the statement, so the bytes cannot
        // be swapped for different ones after signing.
        const timestamp = Date.now();
        const signature = await signMessage(storeMessage(tokenId, mint.patient, digest, timestamp));

        await storeRecord({
          tokenId,
          patient: mint.patient,
          recordType: mint.recordType,
          fileName: mint.file.name,
          mimeType: mint.file.type || 'application/octet-stream',
          contentKey,
          ciphertext: toBase64(payload),
          cid: `local://${digest.slice(2, 14)}`,
          timestamp,
          signature,
        });

        // 3. Only the 32-byte digest goes on-chain. The record type stays in
        //    the server row from step 2 — it is clinical data on a public log.
        const tx = await writeAs('mintRecord', [
          mint.patient,
          digest,
          `local://${digest.slice(2, 14)}`,
        ]);
        await tx.wait();
        setMint({ patient: '', recordType: 'MRI_SCAN', file: null });
      },
      {
        successTitle: 'Record minted',
        successDetail:
          'The token is now owned by the patient, not by the hospital — check ownerOf on Etherscan.',
      }
    );

  const revokeRecord = () =>
    run(
      'Revoke record',
      async () => {
        const tokenId = Number(revokeId);
        if (!Number.isInteger(tokenId) || tokenId <= 0) throw new Error('Enter a token ID.');
        const tx = await writeAs('revokeRecord', [tokenId]);
        await tx.wait();
        setRevokeId('');
        await load();
      },
      { successDetail: 'The record is burned on-chain. A replacement would be issued to a new wallet.' }
    );

  const testTransferBlock = () =>
    run(
      'Attempt transfer',
      async () => {
        const tokenId = Number(revokeId) || 1;
        try {
          // A simulated call, so proving the point costs no gas — along the same path
          // the real write would take, or it would not be simulating anything.
          await simulateAs('transferFrom', [account, account, tokenId]);
        } catch (error) {
          return describeError(error).title;
        }
        throw new Error(
          'The transfer succeeded. Soulbound enforcement is broken — that should be impossible.'
        );
      },
      {
        successTitle: 'Reverted, as designed',
        successDetail: (revertName) =>
          `The contract refused the transfer (${revertName}). Even the owner cannot move a record — the code path does not exist.`,
      }
    );

  return (
    <>
      <PageHeader
        kicker="Hospital IT · Admin"
        title="Operations console"
        lead="Register identities, grant roles, mint records and revoke them. Only this wallet can mint — and that restriction lives in the contract, not on this page."
        aside={
          <button type="button" onClick={load} className="btn-secondary">
            Refresh
          </button>
        }
      />

      {(handoffPatient || handoffType) && (
        <Callout tone="accent" className="mb-5" title="Fulfilling a request from the dashboard">
          The mint form below is already filled in for{' '}
          <span className="mono">{handoffPatient || 'no patient selected'}</span>
          {handoffType ? <span className="mono"> · {handoffType}</span> : null}. Attach the file and
          mint — the request itself is already recorded on-chain and needs no further action.
        </Callout>
      )}

      {!account && (
        <Callout tone="warn" className="mb-5" title="Connect the admin wallet">
          Connect MetaMask with the Platform account. If you are using a different account, the
          non-admin revert is worth trying — it is the headline proof.
        </Callout>
      )}

      {account && !isAdmin && (
        <Callout tone="danger" className="mb-5" title="This wallet is not the admin">
          You can still press mint below. The transaction will revert with a missing-role error — the
          website will not stop you, because the website is not the gate. That failure is the
          demonstration.
        </Callout>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="1 · Register an identity"
          subtitle="Identity creation is itself an auditable on-chain event."
        >
          <div className="space-y-3">
            <AddressInput
              label="Wallet address"
              value={newIdentity.address}
              onChange={(v) => setNewIdentity((c) => ({ ...c, address: v }))}
            />
            <Field label="Label" hint="A role title only — never personal data. Stored off-chain.">
              <input
                className="input"
                value={newIdentity.label}
                onChange={(event) => setNewIdentity((c) => ({ ...c, label: event.target.value }))}
                placeholder="e.g., Cardiology"
              />
            </Field>
            <AddressInput
              label="Facility (optional)"
              value={newIdentity.facility}
              onChange={(v) => setNewIdentity((c) => ({ ...c, facility: v }))}
              hint="Staff only: the hospital IT wallet. Leave empty for patients and platform identities."
              showMyAddress={false}
            />
            <button
              type="button"
              onClick={createIdentity}
              disabled={isBusy('Register identity')}
              className="btn-primary w-full"
            >
              {isBusy('Register identity') ? <Busy label="Confirming…" /> : 'createIdentity'}
            </button>
          </div>
        </Card>

        <Card
          title="2 · Grant a role"
          subtitle="MANAGER for clinicians and labs, AUDITOR for compliance, HOSPITAL for a hospital IT wallet."
        >
          <div className="space-y-3">
            <AddressInput
              label="Wallet address"
              value={roleGrant.address}
              onChange={(v) => setRoleGrant((c) => ({ ...c, address: v }))}
            />
            <Field label="Role">
              <div className="flex flex-wrap gap-2">
                {['MANAGER_ROLE', 'AUDITOR_ROLE', 'HOSPITAL_ROLE'].map((role) => (
                  <button
                    key={role}
                    type="button"
                    aria-pressed={roleGrant.role === role}
                    onClick={() => setRoleGrant((c) => ({ ...c, role }))}
                    className={`mono flex-1 rounded-lg border px-3 py-2 text-[11px] font-medium transition ${
                      roleGrant.role === role
                        ? 'border-peacock-300 bg-peacock-50 text-peacock-700'
                        : 'border-line bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {role}
                  </button>
                ))}
              </div>
            </Field>
            <button
              type="button"
              onClick={grantRole}
              disabled={isBusy('Grant role')}
              className="btn-primary w-full"
            >
              {isBusy('Grant role') ? <Busy label="Confirming…" /> : 'grantRole'}
            </button>
          </div>
        </Card>

        <Card
          title="3 · Register a facility"
          subtitle="The hospital IT wallet becomes the facility. The name lives off-chain."
        >
          <div className="space-y-3">
            <AddressInput
              label="Hospital IT wallet"
              value={newFacility.it}
              onChange={(v) => setNewFacility((c) => ({ ...c, it: v }))}
            />
            <Field label="Facility name" hint="Stored in the directory, never on-chain.">
              <input
                className="input"
                value={newFacility.name}
                onChange={(event) => setNewFacility((c) => ({ ...c, name: event.target.value }))}
                placeholder="e.g., City Care Hospital"
              />
            </Field>
            <button
              type="button"
              onClick={createFacility}
              disabled={isBusy('Register facility')}
              className="btn-primary w-full"
            >
              {isBusy('Register facility') ? <Busy label="Confirming…" /> : 'createFacility'}
            </button>
          </div>
        </Card>

        <Card
          className="lg:col-span-2"
          title="4 · Mint a record"
          subtitle="The file is encrypted in this browser. Only the 32-byte digest reaches the chain."
          tone={isAdmin ? 'default' : 'warn'}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <AddressInput
                label="Patient address"
                value={mint.patient}
                onChange={(v) => setMint((c) => ({ ...c, patient: v }))}
                hint="The patient must have a registered identity, or the mint reverts."
              />

              <Field label="Record type">
                <div className="flex flex-wrap gap-1.5">
                  {RECORD_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={mint.recordType === type}
                      onClick={() => setMint((c) => ({ ...c, recordType: type }))}
                      className={`rounded-institutional border px-2.5 py-1 text-[11px] font-medium transition ${
                        mint.recordType === type
                          ? 'border-peacock-300 bg-peacock-50 text-peacock-700'
                          : 'border-line bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            <div className="space-y-3">
              <Field
                label="Record file"
                hint={
                  mint.file
                    ? `${mint.file.name} · ${formatBytes(mint.file.size)} — will be encrypted before it leaves this tab`
                    : 'Any file. It never leaves the browser in plaintext.'
                }
              >
                <input
                  type="file"
                  onChange={(event) => setMint((c) => ({ ...c, file: event.target.files?.[0] || null }))}
                  className="block w-full cursor-pointer rounded-lg border border-line-strong bg-white text-xs text-slate-600 file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                />
              </Field>

              <button
                type="button"
                onClick={mintRecord}
                disabled={isBusy('Mint record')}
                className="btn-primary w-full"
              >
                {isBusy('Mint record') ? (
                  <Busy label="Encrypting, storing, then minting…" />
                ) : (
                  'Encrypt, store and mintRecord'
                )}
              </button>

              <p className="text-[13px] leading-relaxed text-slate-500">
                Three steps, in this order: encrypt here, store the ciphertext, then put the digest
                on-chain. The contract refuses the third step for any wallet without
                DEFAULT_ADMIN_ROLE.
              </p>
            </div>
          </div>
        </Card>

        <Card
          title="4 · Revoke, and try to break soulbound"
          subtitle="Both are useful to watch. One is irreversible, the other just proves a point."
        >
          <div className="space-y-3">
            <Field label="Token ID">
              <input
                className="input"
                value={revokeId}
                onChange={(event) => setRevokeId(event.target.value.replace(/\D/g, ''))}
                placeholder="1"
                inputMode="numeric"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={revokeRecord}
                disabled={isBusy('Revoke record')}
                className="btn-danger"
              >
                {isBusy('Revoke record') ? <Busy label="Confirming…" /> : 'revokeRecord'}
              </button>
              <button
                type="button"
                onClick={testTransferBlock}
                disabled={isBusy('Attempt transfer')}
                className="btn-secondary"
              >
                {isBusy('Attempt transfer') ? <Busy label="Simulating…" /> : 'Try transferFrom (should revert)'}
              </button>
            </div>
            <Callout tone="warn">
              Revoking burns the token permanently — it is the documented path for a lost wallet, not
              an undo. The transfer check is a simulated call, so it costs no gas.
            </Callout>
          </div>
        </Card>

        <Card
          title="Registered identities"
          subtitle={
            loadError
              ? `${identities.length} from the last successful read · not current`
              : `${identities.length} found in the IdentityCreated log`
          }
        >
          {loadError && (
            <Callout tone="danger" title="Could not read from the backend">
              {loadError}
            </Callout>
          )}
          {loading && !loadError && <SkeletonRows rows={4} columns={3} />}
          {!loadError && !loading && identities.length === 0 && (
            <EmptyState title="No identities registered yet" hint="Register one above to begin." />
          )}
          {/*
            The rows stay on screen after a failed reload, and that is deliberate — they
            are real, just not current, and blanking the panel would throw away information
            the operator wants. What was wrong is that they were rendered as though nothing
            had gone wrong: this branch was the only one that did not test `loadError`, so a
            failed read showed an error and a full list at once, with nothing saying which
            was true. The subtitle and the note below now say it.
          */}
          {loadError && identities.length > 0 && (
            <p className="mb-2 text-xs leading-relaxed text-slate-600">
              The list below is the last successful read, kept so a backend blip does not empty
              the panel. It may be out of date.
            </p>
          )}
          {identities.length > 0 && (
            <ul className="divide-y divide-line">
              {identities.map((entry) => (
                <li key={entry.account} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-ink">{entry.label}</span>
                      {entry.roles.admin && <Pill tone="peacock">admin</Pill>}
                      {entry.roles.manager && <Pill tone="peacock">manager</Pill>}
                      {entry.roles.auditor && <Pill tone="peacock">auditor</Pill>}
                      {!entry.active && <Status state="revoked" />}
                    </div>
                    <p className="mono mt-0.5 truncate text-slate-500">{entry.account}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard?.writeText(entry.account).then(
                        () => toast.ok('Address copied'),
                        () => {}
                      )
                    }
                    className="shrink-0 rounded-institutional border border-line px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-slate-50"
                  >
                    Copy
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        className="mt-5"
        title="Audit trail — the most recent events on this contract"
        subtitle="Nobody maintains a log file. The chain is the log."
        right={<Pill tone="slate">{events.length} shown</Pill>}
      >
        {loading && !events.length ? (
          <SkeletonRows rows={5} columns={3} />
        ) : events.length === 0 ? (
          <EmptyState title="No events yet" hint="Anything the contract records will appear here." />
        ) : (
          <ol className="space-y-2">
            {events.map((event) => (
              <li
                key={`${event.txHash}-${event.name}-${event.blockNumber}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-2 last:border-0 last:pb-0"
              >
                <Pill tone="slate">{event.name}</Pill>
                <span className="mono text-slate-400">block {event.blockNumber}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600">
                  {Object.entries(event.args)
                    .filter(([, v]) => v !== '' && v !== null)
                    .map(([k, v]) => `${k}=${String(v).slice(0, 22)}`)
                    .join('  ')}
                </span>
                <a
                  href={`${TX_EXPLORER}${event.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-peacock-700 underline decoration-dotted underline-offset-2"
                >
                  etherscan ↗
                </a>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
