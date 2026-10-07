import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isAddress, ZeroAddress } from 'ethers';
import { useChain, describeError, contractError } from '../chain';
import { CHAIN_ID, CONTRACT_ADDRESS } from '../contract';
import { encryptRecord, digestOf, formatBytes, toBase64 } from '../crypto';
import { chainIdentities, storeRecord, recordIdentity, recordFacility, pendingRegistrations } from '../services/api';
import {
  facilityMessage,
  identityMessage,
  newSignatureNonce,
  storeMessage,
} from '../lib/wireMessages';
import { DEMO_ACCOUNTS } from '../config/demoAccounts';
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
  const { account, roles, readContract, writeAs, simulateAs, signMessage, refresh, isDemo } = useChain();
  const toast = useToast();
  const onDone = useCallback(() => refresh(), [refresh]);
  const { run, isBusy } = useTx({ onDone });

  const [identities, setIdentities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [newIdentity, setNewIdentity] = useState({ address: '', label: '', facility: '' });
  const [roleGrant, setRoleGrant] = useState({ address: '', role: 'MANAGER_ROLE' });
  const [newFacility, setNewFacility] = useState({ it: '', name: '' });
  const [mint, setMint] = useState({ patient: '', recordType: 'MRI_SCAN', file: null });
  const [revokeId, setRevokeId] = useState('');
  // Who has enrolled but has no identity yet. See loadPending below.
  const [pending, setPending] = useState([]);
  const [pendingError, setPendingError] = useState(null);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [facilityName, setFacilityName] = useState('');
  const [assigning, setAssigning] = useState(null);

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

  /**
   * Enrolments the contract has no identity for.
   *
   * The list is SIGNED, because it carries masked email addresses — the only read in the
   * app that requires it. The other directory reads are open by decision; an open list of
   * who has signed up is a different thing from an open list of hospitals.
   */
  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    setPendingError(null);

    // This list is the app's only signed read, because it carries masked email addresses.
    // A persona holds no key, so asking would post a body with no signature and the server
    // would answer 400 — which reads like a fault in the console rather than the
    // demonstration behaving as designed.
    if (isDemo) {
      setPending([]);
      setPendingError(
        'This list is signed, because it carries masked email addresses — and a demo persona holds no key. Connect a real admin wallet to read it. Everything else on this page is live chain data.'
      );
      setPendingLoading(false);
      return;
    }

    try {
      const result = await pendingRegistrations();
      setPending(result.pending || []);
    } catch (error) {
      // Store the MESSAGE, not the error object. Rendering the object throws React #31 —
        // 'Objects are not valid as a React child' — and this catch runs whenever the
        // signed read fails, which is precisely when a readable message matters most.
        setPendingError(describeError(error).detail || error.message);
    } finally {
      setPendingLoading(false);
    }
  }, [signMessage]);

  /**
   * Loaded once per account, through a ref.
   *
   * `loadPending` is a useCallback over `signMessage`, and this effect used to depend on
   * it. When `signMessage`'s own identity changes -- which it does when the provider is
   * re-created -- the effect re-fires, which sets state, which re-renders, which yields a
   * new callback: MetaMask was asked to sign again and again, every prompt driving the
   * next. A signed read should cost one signature per visit, so the loader is held in a
   * ref and the effect depends on the account alone.
   */
  const loadPendingRef = useRef(loadPending);
  loadPendingRef.current = loadPending;
  useEffect(() => {
    if (account) loadPendingRef.current();
  }, [account]);

  /**
   * Register the identity and grant the role, in the order the contract demands.
   *
   * THE HOSPITAL'S ORDER IS LOAD-BEARING. `createIdentity(addr, addr)` reverts
   * `NotAFacility` unless `createFacility` has run first — that is the exact failure that
   * stopped the hospital registering anything earlier in this project. Encoding the
   * sequence here rather than expecting whoever clicks to remember is the entire reason
   * these buttons exist rather than a form.
   *
   * A doctor is registered with facility 0 (global), which matches the contract's own note
   * that doctors are scoped by consent grants rather than by facility membership.
   */
  const ROLE_FOR = { auditor: 'AUDITOR_ROLE', doctor: 'MANAGER_ROLE', hospital: 'HOSPITAL_ROLE' };

  const assign = useCallback(async (row, role, facilityLabel = '') => {
    const addr = row.address;
    setAssigning(addr + role);
    try {
      // `run` never throws -- it catches, reports and returns { ok, error }. Awaiting it
      // and ignoring the result meant a FAILED assignment fell through to the success toast
      // below, so the panel claimed success while the chain said otherwise.
      const outcome = await run(`Assign ${role}`, async () => {
        if (role === 'hospital') {          // Checked rather than attempted: createFacility reverts if the facility exists, and a
          // retry after a failed grant must not die on a step that already succeeded.
          const contract = await readContract();
          if (!(await contract.facilities(addr))) {
            // A seeded persona carries its own name; the form field is for anyone else.
            const name = facilityLabel || facilityName.trim() || `Hospital ${addr.slice(0, 6)}`;
            const created = await writeAs('createFacility', [addr, name]);
            await created.wait();
          }
        }
        // The identity may already exist from a previous attempt whose grant failed.

        // `createIdentity` is create-only and reverts IdentityExists, so tolerating that is what

        // lets this button FINISH a half-completed assignment instead of being stuck on it.

        try {

          const minted = await writeAs('createIdentity', [addr, role === 'hospital' ? addr : ZeroAddress]);

          await minted.wait();

        } catch (error) {

          if (contractError(error)?.name !== 'IdentityExists') throw error;

        }

        const name = ROLE_FOR[role];
        if (name) {          // `readContract` RETURNS A CONTRACT -- it is not a getter. `readContract('MANAGER_ROLE')`
          // ignores its argument and hands back the contract itself, so destructuring a role
          // constant off it yields undefined. `grantRole(undefined, addr)` encodes to nonsense, so
          // the grant silently never happens: every call is signed, gas is spent, and the user is
          // left holding an identity and no role -- which is exactly what was reported.
          const contract = await readContract();
          // `contract.AUDITOR_ROLE()` resolves to an ARRAY -- ethers returns the result tuple
          // for any function with outputs, even a single one. Passing that array as the role
          // argument encodes nonsense, so the grant silently never lands while every call is
          // still signed, and paid for.
          const [constant] = await contract[name]();
          const granted = await writeAs('grantRole', [constant, addr]);
          await granted.wait();
        }
      });

      // Verified, not assumed. The row is re-read from the chain rather than removed
      // because the sequence returned: a button that reports success without checking is
      // how you come to believe a role landed when a popup was dismissed.
      await loadPending();
      // `run` never throws: it catches, reports and returns { ok, error }. Ignoring the
      // result meant a FAILED assignment fell through to a success toast, so the panel
      // claimed the role had been granted while the chain said otherwise.
      if (outcome.ok) {
        toast.ok(`${role} assigned`, `${addr.slice(0, 10)}… is registered${ROLE_FOR[role] ? ' and holds its role' : ''}.`);
      } else {
        toast.error('Assignment failed', outcome.error?.detail || outcome.error?.title || 'The contract refused it.');
      }
    } catch (error) {
      toast.error('Assignment failed', describeError(error));
      await loadPending();
    } finally {
      setAssigning(null);
    }
  }, [run, writeAs, readContract, loadPending, toast, facilityName]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
        const identityResult = await chainIdentities();
        setIdentities(identityResult.identities || []);
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

  /**
   * Seed the demo cast in one press.
   *
   * Five personas have to be created in a particular order — a facility before the staff
   * identity that names it, an identity before the role granted on it — and doing it by
   * hand is eight signatures and five label writes, in the right order, without losing
   * your place. That is how the last two resets were done, and one of them was left
   * half-finished for a day.
   *
   * A sequence of `assign` calls rather than new logic, because `assign` already checks
   * before it writes: `createFacility` is skipped when the facility exists, and
   * `IdentityExists` is tolerated on the identity. So this FINISHES a half-seeded cast
   * and costs nothing but reads on a complete one.
   *
   * Each persona runs its own `run`, so the toasts say which step is happening rather
   * than leaving the whole cast behind one spinner.
   */
  const [seeding, setSeeding] = useState(false);

  const seedCast = async () => {
    setSeeding(true);
    try {
      for (const persona of DEMO_ACCOUNTS) {
        await assign(persona, persona.role, persona.facilityName || '');
      }
      await labelCast();
    } finally {
      setSeeding(false);
    }
  };

  /**
   * The labels, which live off-chain.
   *
   * Separate from the assignments because the chain cannot carry them: `IdentityCreated`
   * used to name the account and now does not. A cast with identities and no labels is
   * registered and unreadable, which is exactly what the last reset produced — five rows
   * with empty names.
   */
  const labelCast = () =>
    run(
      'Label the demo cast',
      async () => {
        for (const persona of DEMO_ACCOUNTS) {
          // A hospital's own address IS its facility; everyone else is global.
          const facility = persona.role === 'hospital' ? persona.address : '';
          const timestamp = Date.now();
          const signature = await signMessage(
            identityMessage(persona.address, persona.label, facility, timestamp, account)
          );
          await recordIdentity({
            actor: account,
            account: persona.address,
            label: persona.label,
            facility,
            timestamp,
            signature,
          });
        }
        await load();
      },
      {
        successDetail:
          'Five labels recorded off-chain. The chain holds the identities; the names are the part it refuses to carry.',
      }
    );

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
        //
        // `createIdentity` is create-only and reverts `IdentityExists` for an identity that
        // is already registered. That must not abort the rest of this: the label lives
        // off-chain and is written by the call below, which the server allows for an
        // existing row. Coupling the two meant that once an identity was on chain with no
        // label — because an earlier mirror write was refused — there was no way to attach
        // one, and re-running this form died on chain before reaching it. That is exactly
        // how three identities ended up registered with empty labels.
        //
        // Only this one revert is tolerated. Anything else is a real failure.
        try {
          const tx = await writeAs('createIdentity', [
            newIdentity.address,
            facility || '0x0000000000000000000000000000000000000000',
          ]);
          await tx.wait();
        } catch (error) {
          // The same decoder `describeError` uses. Matching on message text does not work
          // here: the error carries a selector and the words "Already registered" are
          // what we render, so a string test never sees "IdentityExists" and this rethrew
          // — which is why the label still could not be attached after the first attempt
          // at this fix.
          if (contractError(error)?.name !== 'IdentityExists') throw error;
        }
        // The label lives off-chain now: the event carries no name.
        const timestamp = Date.now();
        const signature = await signMessage(
          identityMessage(newIdentity.address, newIdentity.label.trim(), facility, timestamp, account)
        );
        await recordIdentity({
          actor: account,
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
          facilityMessage(newFacility.it, newFacility.name.trim(), timestamp, account)
        );
        await recordFacility({
          actor: account,
          it: newFacility.it,
          name: newFacility.name.trim(),
          timestamp,
          signature,
        });
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

        // The content address, recorded both in the row and on-chain. It is a
        // digest, not a location: the bytes may live in R2 or on disk, and the
        // reader resolves them by recordHash. The old value claimed `local://`
        // and truncated the digest to twelve hex characters — a lie about where
        // it lived, and too short to identify it.
        const cid = `sha256:${digest.slice(2)}`;

        // The plaintext digest, so the public verify page works for the person who
        // registered the record. The chain anchors the ciphertext -- right for the blob,
        // useless to someone holding the scan, and encryption takes a fresh IV so they can
        // never reproduce it. Their own file used to answer "Tampered".
        const plainHash = digestOf(buffer);
        const deadline = Date.now() + 5 * 60 * 1000;
        const nonce = newSignatureNonce();
        const upload = {
          actor: account,
          tokenId,
          patient: mint.patient,
          recordHash: digest,
          recordType: mint.recordType,
          fileName: mint.file.name,
          mimeType: mint.file.type || 'application/octet-stream',
          contentKey,
          cid,
          plainHash,
          deadline,
          nonce,
        };
        const signature = await signMessage(
          storeMessage(upload, { chainId: CHAIN_ID, verifyingContract: CONTRACT_ADDRESS })
        );

        await storeRecord({
          ...upload,
          ciphertext: toBase64(payload),
          signature,
        });

        // 3. Only the 32-byte digest goes on-chain. The record type stays in
        //    the server row from step 2 — it is clinical data on a public log.
        const tx = await writeAs('mintRecord', [
          mint.patient,
          digest,
          cid,
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
          <div className="flex flex-wrap items-center gap-2">
            {/* One press instead of eight signatures in the right order. Idempotent, so
                running it on a half-seeded cast finishes it rather than colliding with it. */}
            <button
              type="button"
              onClick={seedCast}
              disabled={seeding}
              className={seeding ? 'btn-secondary opacity-60' : 'btn-secondary'}
            >
              {seeding ? 'Seeding — confirm each step' : 'Seed the demo cast'}
            </button>
            <button type="button" onClick={load} className="btn-secondary">
              Refresh
            </button>
          </div>
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
          className="lg:col-span-2"
          title="Awaiting an identity"
          subtitle="Wallets that have enrolled but hold no identity on the contract. Enrolment registers nobody — this is that step, with the order the contract requires already applied."
        >
          {pendingError && (
            <Callout tone="danger" title="Could not read pending registrations">
              {pendingError}
            </Callout>
          )}

          {pendingLoading && !pendingError && pending.length === 0 && <SkeletonRows rows={2} />}

          {!pendingLoading && !pendingError && pending.length === 0 && (
            <EmptyState
  title="No pending approvals"
  body="Every enrolled wallet already has an identity, or nobody has signed up yet."
/>
          )}

          {!pendingLoading && pending.length > 0 && (
            <>
              <Field label="Facility name" hint="Used only when assigning Hospital.">
                <input
                  type="text"
                  value={facilityName}
                  onChange={(e) => setFacilityName(e.target.value)}
                  placeholder="City Hospital 101"
                  className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-peacock-400"
                />
              </Field>

              <ul className="mt-1 max-h-[25rem] space-y-2 overflow-y-auto pr-1">
                {pending.map((row) => (
                  <li key={row.address} className="rounded-lg border border-line bg-white p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="mono truncate text-[11px] text-ink">{row.address}</span>
                      <span className="text-[11px] text-slate-500">
                        {row.emailMasked || 'no email on file'}
                      </span>

                      {/* The role they asked for. It leads the buttons below as the primary
                          action, so the ordinary case is one confirm rather than the same
                          decision made twice. It is still a decision: they chose at signup,
                          and nothing is granted until an administrator acts. */}
                      {row.requestedRole && (
                        <span className="rounded-full bg-peacock-50 px-2 py-0.5 text-[10px] font-medium text-peacock-700">
                          asked: {row.requestedRole}
                        </span>
                      )}
                      {/* Which half is done. This row used to vanish the moment its identity landed,
                          which hid the case that needs an operator most: identity granted, role not. */}
                      {row.missing && row.missing.length > 0 && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                          {row.identityActive ? 'identity ok' : 'identity missing'} ·{' '}
                          {row.roleGranted === true ? 'role ok' : row.missing.includes('role') ? 'role missing' : 'no role needed'}
                        </span>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(() => {
                        // The requested role is moved to the front and made primary. Four
                        // equal buttons asked the administrator to re-make a decision the
                        // person had already made -- and offered them the chance to make it
                        // differently by accident. The others stay, because an administrator
                        // must be able to overrule a request.
                        const ALL = ['patient', 'doctor', 'auditor', 'hospital'];
                        const asked = ALL.includes(row.requestedRole) ? row.requestedRole : null;
                        const ordered = asked ? [asked, ...ALL.filter((r) => r !== asked)] : ALL;
                        return ordered.map((role) => {
                          const primary = role === asked;
                          return (
                            <button
                              key={role}
                              type="button"
                              onClick={() => assign(row, role)}
                              disabled={assigning !== null}
                              className={
                                primary
                                  ? 'rounded-lg border border-peacock-600 bg-peacock-600 px-2.5 py-1.5 text-[11px] font-medium capitalize text-white transition hover:bg-peacock-700 disabled:opacity-60'
                                  : 'rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] font-medium capitalize text-slate-600 transition hover:border-peacock-300 hover:bg-peacock-50/50 disabled:opacity-60'
                              }
                            >
                              {assigning === row.address + role ? (
                                <Busy label={role} />
                              ) : primary ? (
                                row.identityActive ? `Grant ${role}` : `Approve as ${role}`
                              ) : (
                                role
                              )}
                            </button>
                          );
                        });
                      })()}
                    </div>
                  </li>
                ))}
              </ul>

              <p className="mt-2 text-[10px] leading-snug text-slate-500">
                One confirmation per role, except <span className="font-semibold">hospital</span> —
                that runs <span className="mono">createFacility</span> first, then
                <span className="mono"> grantRole</span>, then
                <span className="mono"> createIdentity</span>, because the contract refuses an
                identity for a facility that does not exist yet. Expect three confirmations.
              </p>
            </>
          )}
        </Card>

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
          className="lg:col-span-2"
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
          title="5 · Revoke, and try to break soulbound"
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
            <ul className="max-h-[16rem] divide-y divide-line overflow-y-auto pr-1">
              {identities.map((entry) => (
                <li key={entry.account} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-ink">{entry.label}</span>
                      {entry.roles.admin && <Pill tone="peacock">admin</Pill>}
                      {entry.roles.manager && <Pill tone="peacock">manager</Pill>}
                      {entry.roles.auditor && <Pill tone="peacock">auditor</Pill>}
                      {entry.roles.hospital && <Pill tone="peacock">hospital</Pill>}
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
    </>
  );
}
