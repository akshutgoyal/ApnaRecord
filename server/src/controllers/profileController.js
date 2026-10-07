import { ethers } from 'ethers';
import { ProfileModel, isDbReady } from '../models/index.js';
import {
  claimOneUseNonce,
  signedWriteDomain,
  verifyDeadlineMessage,
} from '../lib/signature.js';

// Patient-owned display profiles.
//
// Authorisation is a SIGNATURE, not a session. An EOA proves itself by recovery;
// an account contract validates its owner's signature through EIP-1271. In both
// cases the address being changed must authorize the exact profile message.
//
// A forged profile is worthless: change every name in this collection and
// ownership, consent and verification are all unaffected. The chain decides those.

const PROFILE_FIELDS = ['displayName', 'dateOfBirth', 'bloodGroup', 'allergies', 'emergencyContact'];

/** Hash the exact fields written by a profile update, including omitted-vs-empty. */
export function profilePayloadHash(fields = {}) {
  const values = PROFILE_FIELDS.map((key) => [
    Object.prototype.hasOwnProperty.call(fields, key),
    typeof fields[key] === 'string' ? fields[key] : '',
  ]);
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(values)));
}

/** The exact string the client must sign. Kept in one place so both sides agree. */
export function profileMessage(address, operation, dataHash, deadline, nonce, domain = signedWriteDomain()) {
  return (
    `ApnaRecord profile ${operation}\n` +
    `chainId: ${domain.chainId}\n` +
    `verifyingContract: ${domain.verifyingContract}\n` +
    `address: ${ethers.getAddress(address)}\n` +
    `payloadHash: ${String(dataHash).toLowerCase()}\n` +
    `deadline: ${deadline}\n` +
    `nonce: ${String(nonce).toLowerCase()}`
  );
}

function requireDb(res) {
  if (!isDbReady()) {
    res.status(503).json({
      error: 'DatabaseUnavailable',
      message:
        'Display profiles are off-chain convenience data, so they need the database. ' +
        'Everything authoritative — ownership, consent, verification — still works without it.',
    });
    return true;
  }
  return false;
}

/** GET /api/profiles — every profile, for the dashboards' name lookups. */
export async function listProfiles(req, res) {
  if (requireDb(res)) return;
  try {
    // A profile is off-chain and belongs to one person: blood group, date of birth,
    // allergies, an emergency contact. An admin or auditor reads across the platform;
    // everyone else reads themselves and the patients of a facility they act for.
    // Leaving this open was the worst hole in the API — enumerable by anyone with a URL.
    const { entitledPatients } = await import('../middleware/requireWallet.js');
    const entitled = req.viewer
      ? await entitledPatients(req.viewer).catch(() => new Set())
      : new Set();
    const all = await ProfileModel.find().lean();
    const profiles = entitled
      ? all.filter((p) => entitled.has(String(p.account).toLowerCase()))
      : all;
    return res.json({
      profiles: profiles.map((p) => ({
        account: p.account,
        displayName: p.displayName,
        // The clinical fields are included deliberately. A clinician looking at a
        // record needs the blood group and the allergy list in the same breath as
        // the report — making them a second round-trip per patient would mean a
        // chart that is only ever half-loaded.
        bloodGroup: p.bloodGroup,
        dateOfBirth: p.dateOfBirth,
        allergies: p.allergies,
        emergencyContact: p.emergencyContact,
        verifiedBySignature: p.verifiedBySignature,
        lastSignedAt: p.lastSignedAt,
      })),
      note: 'Off-chain, patient-owned data. The chain remains authoritative for identity, ownership and consent; a profile cannot influence any of the three.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'ProfileReadFailed', message: error.message });
  }
}

/** GET /api/profiles/:address */
export async function getProfile(req, res) {
  if (requireDb(res)) return;
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  try {
    const profile = await ProfileModel.findOne({ account: address.toLowerCase() }).lean();
    return res.json({ profile: profile || null });
  } catch (error) {
    return res.status(500).json({ error: 'ProfileReadFailed', message: error.message });
  }
}

/**
 * PUT /api/profiles/:address
 * Body: { displayName, dateOfBirth, bloodGroup, allergies, emergencyContact, deadline, nonce, signature }
 * Only the wallet that owns the address can write it.
 */
export async function upsertProfile(req, res) {
  if (requireDb(res)) return;
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }

  const { deadline, nonce, signature, ...fields } = req.body || {};
  if (!deadline || !nonce || !signature) {
    return res.status(400).json({
      error: 'SignatureRequired',
      message: 'A signed statement from the wallet is required to change a profile.',
    });
  }

  for (const key of PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key) && typeof fields[key] !== 'string') {
      return res.status(400).json({ error: 'BadRequest', message: `${key} must be text.` });
    }
    if (typeof fields[key] === 'string' && fields[key].length > 300) {
      return res.status(400).json({ error: 'BadRequest', message: `${key} must be at most 300 characters.` });
    }
  }

  const authorization = await verifyDeadlineMessage({
    message: profileMessage(address, 'update', profilePayloadHash(fields), deadline, nonce),
    address,
    deadline,
    nonce,
    signature,
  });
  if (authorization.error) {
    return res.status(403).json({ error: 'SignatureInvalid', message: authorization.error });
  }

  try {
    const claim = await claimOneUseNonce({ bucket: 'signed-write', address, deadline, nonce });
    if (claim) return res.status(claim.status).json({ error: claim.code, message: claim.error });

    const update = {
      verifiedBySignature: true,
      lastSignedAt: new Date(),
    };
    for (const key of PROFILE_FIELDS) {
      if (typeof fields[key] === 'string') update[key] = fields[key];
    }

    const profile = await ProfileModel.findOneAndUpdate(
      { account: address.toLowerCase() },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({
      ok: true,
      profile,
      note: 'Written by a signature from this wallet. No personal data reached the chain.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'ProfileWriteFailed', message: error.message });
  }
}

/**
 * DELETE /api/profiles/:address
 * The patient can erase their own display data. This is the DPDP erasure story
 * for the one thing we actually hold: crypto-shredding covers the record, and
 * this covers the name.
 */
export async function deleteProfile(req, res) {
  if (requireDb(res)) return;
  const { address } = req.params;

  // Headers, never the query string. A signature is a bearer credential: it needs no
  // secret to replay, only a copy. In a URL it gets copied into access logs, browser
  // history, and any `Referer` on a link followed from the page — all of which
  // outlive the request it was minted for. The query-string form is deliberately not
  // accepted as a fallback, because a fallback is just the hole left open.
  const deadline = req.get('x-apnarecord-deadline');
  const nonce = req.get('x-apnarecord-nonce');
  const signature = req.get('x-apnarecord-signature');

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  const authorization = await verifyDeadlineMessage({
    message: profileMessage(address, 'delete', profilePayloadHash({}), deadline, nonce),
    address,
    deadline,
    nonce,
    signature,
  });
  if (authorization.error) {
    return res.status(403).json({ error: 'SignatureInvalid', message: authorization.error });
  }

  try {
    const claim = await claimOneUseNonce({ bucket: 'signed-write', address, deadline, nonce });
    if (claim) return res.status(claim.status).json({ error: claim.code, message: claim.error });
    await ProfileModel.deleteOne({ account: address.toLowerCase() });
    return res.json({
      ok: true,
      note: 'Display profile erased. The on-chain record and its digest are unaffected.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'ProfileDeleteFailed', message: error.message });
  }
}
