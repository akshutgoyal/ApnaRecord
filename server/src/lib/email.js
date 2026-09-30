// EMAIL ADDRESSES, HANDLED AS THE WEAK LOCATOR THEY ARE.
//
// An email address identifies a *channel to reach someone*, not a person. It is free to
// create, free to share, and abandoned without ceremony. So this module is built around
// two rules, exactly as the phone version was:
//
//   1. THE ADDRESS IS NEVER STORED. Lookups key off a keyed HMAC, and the only thing kept
//      for display is a masked form. The plaintext exists inside the send call and then
//      nowhere, so a database dump reveals neither who is registered nor any working code.
//
//   2. AN ADDRESS IS NEVER ENOUGH TO AUTHORISE ANYTHING. It can locate a wallet and trigger
//      a code. Opening the wallet still requires the recovery code. If a verified address
//      could ever unlock a wallet on its own, taking over an inbox would become taking over
//      a medical history — and that is the failure this design exists to make impossible.
//
// Worth saying plainly, because it will matter later: email is a *weaker* locator than a
// phone number. It is trivial to create and trivial to hand over. That is tolerable only
// because of rule 2, and it is why nothing downstream may ever treat a verified address as
// proof of who someone is. When an identity provider eventually occupies that seat, this
// is the seam it replaces — not a foundation to build on.

import crypto from 'node:crypto';
import { masterKey } from './codes.js';

/** Local part ≤ 64 per RFC 5321; the whole address ≤ 254. */
const MAX_LOCAL = 64;
const MAX_TOTAL = 254;

/**
 * Normalise an address, or throw with a reason a person can act on.
 *
 * Deliberately pragmatic rather than RFC-perfect. Attempting to fully validate an email
 * address with a regex is a well-known trap — the grammar allows comments, quoted strings
 * and domain literals that no product wants to accept. This checks the shape and the
 * limits, which catches the mistakes people actually make, and leaves the rest to the
 * delivery attempt.
 */
export function normaliseEmail(input) {
  if (typeof input !== 'string') throw new Error('An email address is required.');

  const trimmed = input.trim().toLowerCase();

  if (!trimmed) throw new Error('An email address is required.');
  if (trimmed.length > MAX_TOTAL) {
    throw new Error('That email address is too long.');
  }

  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) {
    throw new Error('That does not look like an email address — it needs exactly one "@".');
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  if (!local || !domain) throw new Error('That does not look like an email address.');
  if (local.length > MAX_LOCAL) throw new Error('That email address has an unusually long first part.');
  if (!domain.includes('.')) {
    throw new Error('That email address needs a domain, like example.com.');
  }
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    throw new Error('That email address has a malformed domain.');
  }
  if (/[\s"(),:;<>[\\\]]/.test(trimmed)) {
    throw new Error('That email address contains characters that are not allowed.');
  }

  return trimmed;
}

/**
 * A keyed hash, used as the lookup key.
 *
 * Keyed rather than plain because the set of plausible addresses is small enough to
 * enumerate — with the key, a stolen database cannot be walked to discover who is
 * registered.
 */
export function emailHmac(email) {
  const normalised = normaliseEmail(email);
  return crypto.createHmac('sha256', masterKey()).update(normalised).digest('hex');
}

/**
 * What the user is shown back.
 *
 * The first character and the domain, and nothing else. Enough to recognise your own
 * address; not enough for anyone else to. The number of hidden characters is fixed, so
 * the mask does not quietly leak the length of the local part either.
 */
export function maskEmail(email) {
  const normalised = normaliseEmail(email);
  const at = normalised.indexOf('@');
  return `${normalised.slice(0, 1)}•••${normalised.slice(at)}`;
}
