// WALLET ENROLMENT.
//
// Creates the account a user never knows they have. The client generates the key
// and locks it behind a recovery code; this server stores the locked blob and
// nothing else. There is no endpoint here that can sign, decrypt, or act as a user,
// and there must never be one — the moment such an endpoint exists, the hospital
// can consent on a patient's behalf and the product's central claim becomes false.
//
// A NOTE ON THE BLOB FETCH. `GET /api/wallet/:address` is public, and was very
// nearly gated behind the contact grant. It was left public deliberately — the
// ciphertext is useless without a 100-bit recovery code, whereas a patient who
// changed their number would have lost access to soulbound records for ever. The
// reasoning is recorded on getWallet below, because the decision is a trade and not
// an oversight. `POST /api/wallet/lookup` is the recommended path.

import { ethers } from 'ethers';
import { EnrolmentModel, isDbReady } from '../models/index.js';
import { ensureFunded, dripperStatus } from '../services/dripper.js';
import { consumeGrant } from '../services/otp.js';

const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_SEALED_CHARS = 512;
const MAX_SALT_CHARS = 64;

/**
 * A limiter on the blob fetch.
 *
 * Not a security boundary — the blob is ciphertext and its confidentiality rests
 * entirely on the recovery code. This is here so the endpoint cannot be used to
 * enumerate which addresses are enrolled at volume, which is a privacy question
 * rather than a cryptographic one.
 */
const LOOKUP_WINDOW_MS = 60 * 1000;
const LOOKUP_MAX = 20;
const lookupHits = new Map();

function noteAddressLookup(ip) {
  const now = Date.now();
  const hits = (lookupHits.get(ip) || []).filter((at) => now - at < LOOKUP_WINDOW_MS);
  if (hits.length >= LOOKUP_MAX) return false;
  hits.push(now);
  lookupHits.set(ip, hits);
  if (lookupHits.size > 5000) {
    for (const [key, value] of lookupHits) {
      if (!value.some((at) => now - at < LOOKUP_WINDOW_MS)) lookupHits.delete(key);
    }
  }
  return true;
}

/** Kept in one place so client and server cannot drift apart. */
export function enrolMessage(address, timestamp) {
  return (
    'ApnaRecord create wallet\n' +
    `address: ${ethers.getAddress(address)}\n` +
    `timestamp: ${timestamp}`
  );
}

export function dripMessage(address, timestamp) {
  return (
    'ApnaRecord request test funds\n' +
    `address: ${ethers.getAddress(address)}\n` +
    `timestamp: ${timestamp}`
  );
}

/** Recover the signer and require it to be the address in question. */
function verify(message, address, timestamp, signature) {
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
    return 'The signature is stale. Refresh the page and try again.';
  }
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    return 'That signature could not be read.';
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return `That signature was made by ${recovered}, not by ${address}.`;
  }
  return null;
}

function requireDb(res) {
  if (!isDbReady()) {
    res.status(503).json({
      error: 'DatabaseUnavailable',
      message:
        'Wallets are stored sealed in the database, so enrolment and unlock need it. ' +
        'Everything already on-chain — ownership, consent, verification — still works without it.',
    });
    return true;
  }
  return false;
}

function looksLikeBase64(value, maxChars) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars && /^[A-Za-z0-9+/]+=*$/.test(value);
}

/**
 * POST /api/wallet/enrol
 * Body: { address, sealed, salt, iterations, timestamp, signature, grantToken }
 *
 * The signature proves the caller holds the key being enrolled, so nobody can
 * pre-register an address they do not control and squat on someone else's futures.
 *
 * The grant proves the caller controls the email address being bound. Both are
 * required, and they prove different things: that you hold this key, and that this
 * address is yours. An address alone would let anyone bind someone else's
 * wallet to their own number and then look it up later.
 */
export async function enrol(req, res) {
  if (requireDb(res)) return;

  const { address, sealed, salt, iterations, timestamp, signature, grantToken } = req.body || {};

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  if (!looksLikeBase64(sealed, MAX_SEALED_CHARS)) {
    return res.status(400).json({ error: 'BadRequest', message: 'sealed must be base64 ciphertext.' });
  }
  if (!looksLikeBase64(salt, MAX_SALT_CHARS)) {
    return res.status(400).json({ error: 'BadRequest', message: 'salt must be base64.' });
  }
  if (!timestamp || !signature) {
    return res.status(400).json({
      error: 'SignatureRequired',
      message: 'A signed statement from the new wallet is required.',
    });
  }

  const problem = verify(enrolMessage(address, timestamp), address, timestamp, signature);
  if (problem) return res.status(403).json({ error: 'SignatureInvalid', message: problem });

  // Spend the contact grant. This is what makes the address on the record a verified
  // address rather than a claim.
  let grant;
  try {
    grant = await consumeGrant(grantToken);
  } catch (error) {
    return res.status(403).json({
      error: error.code || 'ContactVerificationRequired',
      message: error.message,
    });
  }

  try {
    const existing = await EnrolmentModel.findOne({ address: address.toLowerCase() });

    // Re-enrolling from the same key is a no-op rather than an error: a refresh
    // mid-flow should not fail the user, and the blob for a given key is stable.
    if (existing && existing.sealed !== sealed) {
      return res.status(409).json({
        error: 'AlreadyEnrolled',
        message:
          'This address already has a sealed key. If you have lost your recovery code, ' +
          'the key cannot be replaced — the record is soulbound and recovery is not yet built.',
      });
    }

    const enrolment = await EnrolmentModel.findOneAndUpdate(
      { address: address.toLowerCase() },
      {
        address: address.toLowerCase(),
        sealed,
        salt,
        iterations: Number(iterations) || 600000,
        identity: {
          kind: 'email',
          emailHmac: grant.contactHmac,
          // Taken from the grant, which the server derived. A client cannot put
          // arbitrary text next to a verified number.
          emailMasked: grant.contactMasked,
          value: '',
          verifiedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Fund immediately rather than lazily. Lazily dripping puts a pending
    // transaction in the way of the user's very first action, which is the worst
    // possible moment to make them wait on Sepolia.
    let drip;
    try {
      drip = await ensureFunded(address);
    } catch (error) {
      // The wallet exists and the blob is stored. Failing the whole enrolment
      // because the float hiccuped would lose an account we can still fund later.
      console.warn(`[Wallet] Enrolled ${address} but the drip failed: ${error.message}`);
      drip = { ok: false, skipped: true, reason: error.message };
    }

    return res.status(201).json({
      ok: true,
      address: enrolment.address,
      emailMasked: enrolment.identity.emailMasked,
      createdAt: enrolment.createdAt,
      drip,
      note:
        'The server holds a sealed blob and cannot open it. Your recovery code is the only ' +
        'thing that can, which is why losing it loses the wallet.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'EnrolFailed', message: error.message });
  }
}

/**
 * POST /api/wallet/lookup  { grantToken }
 *
 * Find the wallets bound to an email address the caller has just proved they control.
 *
 * This replaces looking a wallet up by typing its address, which was the weakest
 * point in the design: an address is public, so anyone could name one and receive a
 * ciphertext to attack offline. Now the lookup requires a verified address.
 *
 * It still returns ciphertext, and only ciphertext. Knowing which address belongs
 * to which address is a real leak on its own, which is precisely why it is
 * gated.
 */
export async function lookupWallets(req, res) {
  if (requireDb(res)) return;

  let grant;
  try {
    grant = await consumeGrant(req.body?.grantToken);
  } catch (error) {
    return res.status(401).json({ error: error.code || 'ContactVerificationRequired', message: error.message });
  }

  try {
    const rows = await EnrolmentModel.find({ 'identity.emailHmac': grant.contactHmac }).lean();
    return res.json({
      wallets: rows.map((row) => ({
        address: row.address,
        sealed: row.sealed,
        salt: row.salt,
        iterations: row.iterations,
        emailMasked: row.identity?.emailMasked || '',
        createdAt: row.createdAt,
      })),
      note:
        'Ciphertext. Useless without the recovery code, which the server has never seen. ' +
        'Verifying a number can locate a wallet; it can never open one.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'WalletReadFailed', message: error.message });
  }
}

/**
 * GET /api/wallet/:address
 *
 * The sealed blob, so a new device can open a wallet it has never seen.
 *
 * WHY THIS IS NOT GATED, having first been gated. The obvious move is to require a
 * verified email address before handing over a blob, and that is what this did for
 * an afternoon. It was reverted deliberately, because the trade is bad:
 *
 *   What gating buys: an attacker who knows an address can no longer collect a
 *   ciphertext to attack offline. But the ciphertext is AES-GCM over a key derived
 *   from a 100-bit recovery code at 600,000 PBKDF2 iterations. Harvesting it is not
 *   a step towards anything — the offline attack is already infeasible by a margin
 *   of about 2^100.
 *
 *   What gating costs: a patient who changes their email address can no longer find
 *   their wallet at all. And because the records are soulbound with no transfer and
 *   no recovery, that is not an inconvenience — it is losing their medical history
 *   permanently.
 *
 * So the far smaller risk is the one to take. The fetch is rate-limited instead, and
 * the email path is the one the app recommends because it is better for the user
 * rather than because the address path is unsafe.
 *
 * If the email address is ever treated as a required locator, this decision has to be
 * revisited together with recovery — the two are the same problem.
 */
export async function getWallet(req, res) {
  if (requireDb(res)) return;
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }

  if (!noteAddressLookup(req.ip)) {
    return res.status(429).json({
      error: 'TooManyRequests',
      message: 'Too many wallet lookups from this address. Try again shortly.',
    });
  }

  try {
    const enrolment = await EnrolmentModel.findOne({ address: address.toLowerCase() }).lean();
    if (!enrolment) {
      return res.status(404).json({
        error: 'NotEnrolled',
        message: 'No wallet has been created for that address.',
      });
    }

    return res.json({
      enrolment: {
        address: enrolment.address,
        sealed: enrolment.sealed,
        salt: enrolment.salt,
        iterations: enrolment.iterations,
        emailMasked: enrolment.identity?.emailMasked || '',
        createdAt: enrolment.createdAt,
      },
      note: 'Ciphertext. Useless without the recovery code, which the server has never seen.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'WalletReadFailed', message: error.message });
  }
}

/**
 * POST /api/wallet/:address/drip
 * Body: { timestamp, signature }
 *
 * Signed, so this cannot be used as an open faucet by anyone who happens to know an
 * enrolled address. Idempotent and floor-checked underneath, so repeat calls are
 * harmless — they simply find the wallet already funded.
 */
export async function requestDrip(req, res) {
  if (requireDb(res)) return;
  const { address } = req.params;
  const { timestamp, signature } = req.body || {};

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }

  const problem = verify(dripMessage(address, timestamp), address, timestamp, signature);
  if (problem) return res.status(403).json({ error: 'SignatureInvalid', message: problem });

  try {
    const enrolment = await EnrolmentModel.findOne({ address: address.toLowerCase() });
    if (!enrolment) {
      return res.status(404).json({ error: 'NotEnrolled', message: 'That wallet is not enrolled.' });
    }
    const result = await ensureFunded(address, { reason: 'top-up' });
    return res.json({ ok: result.ok, ...result });
  } catch (error) {
    return res.status(502).json({ error: 'DripFailed', message: error.message });
  }
}

/** GET /api/dripper — the float's health. Preflight a demo with this. */
export async function dripperHealth(req, res) {
  try {
    return res.json(await dripperStatus());
  } catch (error) {
    return res.status(502).json({ error: 'DripperUnavailable', message: error.message });
  }
}
