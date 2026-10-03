import { ethers } from 'ethers';
import {
  FacilityModel,
  PatientLinkModel,
  RequestModel,
  IdentityModel,
  isDbReady,
} from '../models/index.js';
import { call } from '../services/chain.js';

// THE OFF-CHAIN DIRECTORY.
//
// The contract deliberately stopped carrying metadata: no labels, no record
// types, no patient links, no request contents. That is what makes the chain
// publishable — but it also means nobody can read a dashboard from the chain
// alone any more. This controller is where that metadata lives, written only
// under a wallet signature, because there is no session to authenticate with.
//
// Writes mirror an on-chain act that already happened (createIdentity,
// createFacility, requestRecord). The server does not re-decide what the chain
// decided; it records the part the chain refused to carry.

const MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Must stay byte-identical to `identityMessage` in `client/src/lib/wireMessages.js`.
 * The two deploy separately so it is duplicated rather than imported, and the
 * test suite asserts they agree.
 */
export function identityMessage(account, label, facility, timestamp) {
  const facilityPart =
    facility && String(facility).trim() !== '' ? ethers.getAddress(facility) : '';
  return (
    'ApnaRecord register identity\n' +
    `account: ${ethers.getAddress(account)}\n` +
    `label: ${String(label || '').slice(0, 80)}\n` +
    `facility: ${facilityPart}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Must stay byte-identical to `facilityMessage` in `client/src/lib/wireMessages.js`.
 */
export function facilityMessage(it, name, timestamp) {
  return (
    'ApnaRecord register facility\n' +
    `it: ${ethers.getAddress(it)}\n` +
    `name: ${String(name || '').slice(0, 120)}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Must stay byte-identical to `requestMessage` in `client/src/lib/wireMessages.js`.
 */
export function requestMessage(requestId, patient, recordType, timestamp) {
  return (
    'ApnaRecord record request\n' +
    `requestId: ${Number(requestId)}\n` +
    `patient: ${ethers.getAddress(patient)}\n` +
    `recordType: ${String(recordType || '').slice(0, 60)}\n` +
    `timestamp: ${timestamp}`
  );
}

function requireDb(res) {
  if (!isDbReady()) {
    res.status(503).json({
      error: 'DatabaseUnavailable',
      message:
        'The directory is off-chain data, so it needs the database. ' +
        'Everything authoritative — ownership, consent, verification — still works without it.',
    });
    return true;
  }
  return false;
}

async function isAdmin(address) {
  const [role] = await call('DEFAULT_ADMIN_ROLE');
  const [has] = await call('hasRole', [role, address]);
  return Boolean(has);
}

async function isFacility(address) {
  const [flag] = await call('facilities', [address]);
  return Boolean(flag);
}

/**
 * Whether an identity write may proceed, given what is already stored.
 *
 * Extracted from the handler because it cannot otherwise be tested: the integration
 * suite runs against a mock whose `hasRole()` and `facilities()` answer for the whole
 * process, so no request in that suite can reach these branches at all. A pure
 * function is the only way to pin the rule down.
 *
 * Returns null to allow, or { status, error, message } to refuse.
 */
export function identityWriteVerdict({ existing, facility, label, isAdmin }) {
  if (isAdmin || !existing) return null;
  // CREATE-ONLY, mirroring `createIdentity` on-chain, which reverts `IdentityExists`
  // rather than rewriting. The handler's upsert IS an overwrite, and without this any
  // hospital could relabel another hospital's staff — or clear their facility to
  // address(0) and have the directory present a colleague as a patient. Re-sending the
  // SAME row stays a no-op, so a retry is still safe.
  const unchanged =
    (existing.facility || '') === (facility ? facility.toLowerCase() : '') &&
    (existing.label || '') === String(label || '').slice(0, 80);
  if (unchanged) return null;
  return {
    status: 409,
    error: 'IdentityExists',
    message: 'That identity is already registered. Only the platform may change an existing record.',
  };
}

/**
 * A request belongs to the clinician who filed it.
 *
 * Request ids are sequential and public — `nextRequestId` reads the next one — so
 * without this a second MANAGER could rewrite another doctor's request by guessing the
 * id, changing the patient it names while the row still claims to be theirs.
 */
export function requestWriteVerdict({ existing, requester }) {
  if (!existing || existing.requester === requester) return null;
  return {
    status: 403,
    error: 'NotAuthorized',
    message: 'That request was filed by another clinician and cannot be rewritten.',
  };
}

/**
 * POST /api/identities
 * Body: { account, label, facility, timestamp, signature }
 *
 * Records the label the chain refused to carry. The signer must be the platform
 * admin (any placement) or a hospital IT wallet placing its own staff or its own
 * patients — the same rule as `createIdentity` on-chain, re-checked here so a
 * row cannot claim a placement the chain would refuse.
 */
export async function recordIdentity(req, res) {
  if (requireDb(res)) return;
  const { account, label, facility, timestamp, signature } = req.body || {};

  if (!ethers.isAddress(account)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid account address.' });
  }
  const facilityAddr =
    facility && String(facility).trim() !== '' ? String(facility).trim() : '';
  if (facilityAddr && !ethers.isAddress(facilityAddr)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid facility address.' });
  }
  if (!timestamp || !signature) {
    return res.status(400).json({ error: 'SignatureRequired', message: 'A signed statement is required.' });
  }

  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
    return res.status(403).json({ error: 'SignatureInvalid', message: 'The signature is stale. Refresh and try again.' });
  }

  let signer;
  try {
    signer = ethers.verifyMessage(identityMessage(account, label || '', facilityAddr, timestamp), signature);
  } catch {
    return res.status(403).json({ error: 'SignatureInvalid', message: 'That signature could not be read.' });
  }

  try {
    const admin = await isAdmin(signer);
    if (!admin) {
      const facilityWallet = await isFacility(signer);
      if (!facilityWallet) {
        // Naming the address is the whole point. This refusal is decided from the
        // SIGNER the signature recovers to, which is not necessarily the account the
        // app has on screen — a wallet holding several accounts can sign with a
        // different one than the header shows. Without the address the message reads
        // as "you are not allowed", when the truth is usually "that was not you".
        return res.status(403).json({
          error: 'NotAuthorized',
          signer,
          message: `${signer} is neither the platform nor a hospital IT wallet, so it cannot register identities. If that is not the account you expected, your wallet signed with a different one.`,
        });
      }
      if (facilityAddr && facilityAddr.toLowerCase() !== signer.toLowerCase()) {
        return res.status(403).json({
          error: 'NotAuthorized',
          signer,
          message: `${signer} may only place identities in its own facility, and this one names ${facilityAddr}.`,
        });
      }
    }

    const verdict = identityWriteVerdict({
      existing: await IdentityModel.findOne({ account: account.toLowerCase() }).lean(),
      facility: facilityAddr,
      label,
      isAdmin: admin,
    });
    if (verdict) {
      return res.status(verdict.status).json({ error: verdict.error, message: verdict.message });
    }

    const row = await IdentityModel.findOneAndUpdate(
      { account: account.toLowerCase() },
      {
        account: account.toLowerCase(),
        label: String(label || '').slice(0, 80),
        facility: facilityAddr ? facilityAddr.toLowerCase() : '',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.status(201).json({ ok: true, identity: row });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/**
 * POST /api/facilities
 * Body: { it, name, timestamp, signature } — signed by the platform admin.
 */
export async function recordFacility(req, res) {
  if (requireDb(res)) return;
  const { it, name, timestamp, signature } = req.body || {};

  if (!ethers.isAddress(it)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid facility address.' });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'BadRequest', message: 'A facility name is required.' });
  }
  if (!timestamp || !signature) {
    return res.status(400).json({ error: 'SignatureRequired', message: 'A signed statement is required.' });
  }

  let signer;
  try {
    signer = ethers.verifyMessage(facilityMessage(it, String(name).slice(0, 120), timestamp), signature);
  } catch {
    return res.status(403).json({ error: 'SignatureInvalid', message: 'That signature could not be read.' });
  }
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
    return res.status(403).json({ error: 'SignatureInvalid', message: 'The signature is stale. Refresh and try again.' });
  }

  try {
    if (!(await isAdmin(signer))) {
      return res.status(403).json({ error: 'NotAuthorized', message: 'Only the platform may register facilities.' });
    }
    const row = await FacilityModel.findOneAndUpdate(
      { it: it.toLowerCase() },
      { it: it.toLowerCase(), name: String(name).slice(0, 120), active: true },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.status(201).json({ ok: true, facility: row });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/**
 * POST /api/requests
 * Body: { requestId, patient, recordType, timestamp, signature } — signed by the
 * requesting clinician. Anchors the contents of a `RecordRequested` event the
 * chain carries only as an id.
 */
export async function recordRequest(req, res) {
  if (requireDb(res)) return;
  const { requestId, patient, recordType, timestamp, signature } = req.body || {};

  if (!Number.isInteger(Number(requestId)) || Number(requestId) <= 0) {
    return res.status(400).json({ error: 'BadRequest', message: 'requestId must be a positive integer.' });
  }
  if (!ethers.isAddress(patient)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid patient address.' });
  }
  if (!timestamp || !signature) {
    return res.status(400).json({ error: 'SignatureRequired', message: 'A signed statement is required.' });
  }

  let signer;
  try {
    signer = ethers.verifyMessage(
      requestMessage(Number(requestId), patient, String(recordType || ''), timestamp),
      signature
    );
  } catch {
    return res.status(403).json({ error: 'SignatureInvalid', message: 'That signature could not be read.' });
  }
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
    return res.status(403).json({ error: 'SignatureInvalid', message: 'The signature is stale. Refresh and try again.' });
  }

  try {
    const [managerRole] = await call('MANAGER_ROLE');
    const [holds] = await call('hasRole', [managerRole, signer]);
    if (!holds) {
      return res.status(403).json({ error: 'NotAuthorized', message: 'Only a clinician holding MANAGER_ROLE may file requests.' });
    }

    const verdict = requestWriteVerdict({
      existing: await RequestModel.findOne({ requestId: Number(requestId) }).lean(),
      requester: signer.toLowerCase(),
    });
    if (verdict) {
      return res.status(verdict.status).json({ error: verdict.error, message: verdict.message });
    }

    const row = await RequestModel.findOneAndUpdate(
      { requestId: Number(requestId) },
      {
        requestId: Number(requestId),
        requester: signer.toLowerCase(),
        patient: patient.toLowerCase(),
        recordType: String(recordType || '').slice(0, 60),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.status(201).json({ ok: true, request: row });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/** GET /api/facilities/:it — the facility, its linked patients, its records. */
export async function facilityDetail(req, res) {
  const { it } = req.params;
  if (!ethers.isAddress(it)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid facility address.' });
  }
  try {
    // `null` means "could not ask", which is NOT "not registered". Collapsing the two
    // reported a chain outage as a facility that does not exist — and the console then
    // offers to register it, which reverts, with nothing to explain why.
    let onChain = null;
    try {
      [onChain] = await call('facilities', [it]);
    } catch {
      onChain = null;
    }
    
    let directory = null;
    let rows = [];
    if (isDbReady()) {
      directory = await FacilityModel.findOne({ it: it.toLowerCase() }).lean();
      rows = await PatientLinkModel.find({ facility: it.toLowerCase(), state: 'linked' }).lean();
    }
    
    // The mirror says who the facility believes it treats; the chain says who it may
    // actually read. They disagree for up to a minute after a link, a discharge or a
    // revocation — and the chain is the one that decides whether a read succeeds.
    const linkedPatients = [];
    let verifiedAgainstChain = true;
    for (const row of rows) {
      try {
        const [stillLinked] = await call('facilityPatient', [it, row.patient]);
        if (stillLinked) linkedPatients.push({ patient: row.patient, consentedAt: row.consentedAt });
      } catch {
        verifiedAgainstChain = false;
        linkedPatients.push({ patient: row.patient, consentedAt: row.consentedAt });
      }
    }
    
    return res.json({
      it: it.toLowerCase(),
      registeredOnChain: onChain === null ? null : Boolean(onChain),
      chainChecked: onChain !== null,
      name: directory?.name || null,
      active: directory?.active ?? null,
      linkedPatients,
      verifiedAgainstChain,
    });  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/** GET /api/patients/:address/links — which facilities a patient is linked to, plus pending requests. */
export async function patientLinks(req, res) {
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  try {
    if (!isDbReady()) return res.json({ patient: address.toLowerCase(), linked: [], pending: [] });
    const rows = await PatientLinkModel.find({ patient: address.toLowerCase() }).lean();
    const names = new Map();
    const facilities = await FacilityModel.find({
      it: { $in: rows.map((r) => r.facility) },
    }).lean();
    for (const f of facilities) names.set(f.it, f.name);
    // The chain decides whether a link is LIVE. The mirror supplies the facility name and
    // the timestamps, which the chain does not carry — but it trails the chain by up to a
    // minute, so reading state from it meant a link approved moments ago still showed as
    // "waiting for you", and one revoked on-chain still showed as open.
    const linked = [];
    const pending = [];
    let verifiedAgainstChain = true;
    
    for (const row of rows) {
      let onChain = null;
      try {
        const [value] = await call('facilityPatient', [row.facility, address]);
        onChain = Boolean(value);
      } catch {
        // Could not ask. Fall back to the mirror, and SAY SO rather than letting a stale
        // answer pass as a current one.
        verifiedAgainstChain = false;
      }
    
      const name = names.get(row.facility) || null;
    
      if (onChain === true) {
        linked.push({ facility: row.facility, name, consentedAt: row.consentedAt });
      } else if (onChain === false) {
        // Not linked on chain. Still a request only if the mirror says one was made.
        if (row.state === 'requested') {
          pending.push({ facility: row.facility, name, requestedAt: row.requestedAt });
        }
      } else if (row.state === 'linked') {
        linked.push({ facility: row.facility, name, consentedAt: row.consentedAt });
      } else if (row.state === 'requested') {
        pending.push({ facility: row.facility, name, requestedAt: row.requestedAt });
      }
    }
    
    return res.json({
      patient: address.toLowerCase(),
      linked,
      pending,
      // False when the contract could not be reached and the mirror was trusted alone.
      verifiedAgainstChain,
    });  } catch (error) {
    return res.status(500).json({ error: 'LinkReadFailed', message: error.message });
  }
}
