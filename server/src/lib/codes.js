// CODE AND TOKEN CRYPTO, CONTACT-AGNOSTIC.
//
// Nothing here knows what a contact is. It turns a secret into a code, a code into a
// hash, and a token into a lookup key — which is the same work whether the thing being
// verified is an email address, a phone number, or whatever occupies the seat next.
//
// Separated from lib/email.js deliberately: that module should be about email
// addresses, and this should be about secrets. Mixing them is how a module ends up
// named after one provider while doing five unrelated things.

import crypto from 'node:crypto';

/**
 * The key used for hashing and for HMACs.
 *
 * Required, because every one of these values is stored and every one of them is
 * reversible-by-brute-force without a key. There are only so many email addresses and
 * only a million six-digit codes, so an unkeyed hash would be an unkeyed disclosure.
 */
export function masterKey() {
  const raw = process.env.MASTER_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'MASTER_KEY must be 64 hex characters for contact verification to work. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(raw, 'hex');
}

/** A six-digit code, from a CSPRNG. */
export function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Hash a code against the contact it was issued for.
 *
 * Keyed on the contact as well as the master key, so a code minted for one address
 * cannot be replayed against another even if both happen to be the same six digits.
 */
export function hashCode(contactHmac, code) {
  return crypto.createHmac('sha256', masterKey())
    .update(`${contactHmac}:${code}`)
    .digest('hex');
}

/** Constant-time comparison. A length mismatch returns false rather than throwing. */
export function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** An opaque bearer token for a verified contact, stored only as a hash. */
export function generateGrantToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashGrantToken(token) {
  return crypto.createHmac('sha256', masterKey()).update(token).digest('hex');
}
