import { ethers } from 'ethers';
import { ProfileModel, isDbReady } from '../models/index.js';

// Patient-owned display profiles.
//
// Authorisation is a SIGNATURE, not a session. There is no login, so there is
// nothing to log into — the wallet signs a statement, the server recovers the
// signer, and only that signer may write their own row. This also means nobody
// can rename somebody else's records, which is the obvious attack on a display
// directory.
//
// A forged profile is worthless: change every name in this collection and
// ownership, consent and verification are all unaffected. The chain decides those.

const MAX_AGE_MS = 5 * 60 * 1000;

/** The exact string the client must sign. Kept in one place so both sides agree. */
export function profileMessage(address, timestamp) {
  return (
    'ApnaRecord profile update\n' +
    `address: ${ethers.getAddress(address)}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Recover the signer and confirm it is the address being written to.
 * Returns null when valid, or a reason string when not.
 */
function verifySignature(address, timestamp, signature) {
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
    return 'The signature is stale. Refresh the page and try again.';
  }
  let recovered;
  try {
    recovered = ethers.verifyMessage(profileMessage(address, timestamp), signature);
  } catch {
    return 'That signature could not be read.';
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return `That signature was made by ${recovered}, not by the address being changed.`;
  }
  return null;
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
    const profiles = await ProfileModel.find().lean();
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
 * Body: { displayName, dateOfBirth, bloodGroup, allergies, emergencyContact, timestamp, signature }
 * Only the wallet that owns the address can write it.
 */
export async function upsertProfile(req, res) {
  if (requireDb(res)) return;
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }

  const { timestamp, signature, ...fields } = req.body || {};
  if (!timestamp || !signature) {
    return res.status(400).json({
      error: 'SignatureRequired',
      message: 'A signed statement from the wallet is required to change a profile.',
    });
  }

  const problem = verifySignature(address, timestamp, signature);
  if (problem) {
    return res.status(403).json({ error: 'SignatureInvalid', message: problem });
  }

  try {
    const update = {
      verifiedBySignature: true,
      lastSignedAt: new Date(),
    };
    for (const key of ['displayName', 'dateOfBirth', 'bloodGroup', 'allergies', 'emergencyContact']) {
      if (typeof fields[key] === 'string') update[key] = fields[key].slice(0, 300);
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
  const timestamp = req.get('x-apnarecord-timestamp');
  const signature = req.get('x-apnarecord-signature');

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  const problem = verifySignature(address, timestamp, signature);
  if (problem) return res.status(403).json({ error: 'SignatureInvalid', message: problem });

  try {
    await ProfileModel.deleteOne({ account: address.toLowerCase() });
    return res.json({
      ok: true,
      note: 'Display profile erased. The on-chain record and its digest are unaffected.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'ProfileDeleteFailed', message: error.message });
  }
}
