// MINTING, SENDING AND CHECKING ONE-TIME CODES.
//
// Contact-agnostic by design. Nothing below knows whether the thing being verified is an
// email address or anything else — it normalises a contact, hashes it, issues a code
// against it, and hands back a grant. That is the same work regardless, and keeping the
// distinction out of this file is what would make a second contact type cheap.
//
// The rules are all about what a code must NOT be able to do. A code proves someone can
// receive messages sent to a contact. It must never be a path into a wallet, so a verified
// code yields a short-lived grant that can *locate* a sealed blob and nothing more.
// Opening the blob still needs the recovery code.
//
// Everything is bounded: codes expire, are single-use, are limited to five guesses, cannot
// be re-requested instantly, and are capped per contact per hour.

import { OtpModel, ContactGrantModel, isDbReady } from '../models/index.js';
import { noteHit } from '../lib/rateLimit.js';
import { normaliseEmail, emailHmac, maskEmail } from '../lib/email.js';
import {
  generateCode,
  hashCode,
  timingSafeEqual,
  generateGrantToken,
  hashGrantToken,
} from '../lib/codes.js';
import { sendCodeByEmail } from './emailSender.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// Configurable so the flow can be exercised end to end — a test that has to sleep thirty
// seconds to re-verify a contact is a test that eventually stops being run. Production
// keeps the default.
const RESEND_COOLDOWN_MS = Number(process.env.CONTACT_RESEND_COOLDOWN_MS) || 30 * 1000;
const MAX_CODES_PER_HOUR = Number(process.env.CONTACT_MAX_PER_HOUR) || 5;

function requireDb() {
  if (!isDbReady()) {
    const error = new Error(
      'Verifying a contact needs the database, because codes and grants are stored there. ' +
        'Everything already on-chain still works without it.'
    );
    error.code = 'DatabaseUnavailable';
    throw error;
  }
}

/** Normalise whatever the caller sent, throwing a message a person can act on. */
function normaliseContact(contact) {
  return normaliseEmail(contact);
}

/**
 * Issue and send a code.
 *
 * Throws with a plain reason when it will not send, rather than pretending. The cooldown
 * and the hourly cap give the same message to the user — "wait a moment" — because
 * distinguishing them would tell an attacker which limit they hit.
 */
export async function requestCode(rawContact, purpose = 'enrol') {
  requireDb();

  const contact = normaliseContact(rawContact);
  const hmac = emailHmac(contact);

  const recent = await OtpModel.find({
    contactHmac: hmac,
    purpose,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (recent.length > 0) {
    const sinceLast = Date.now() - new Date(recent[0].createdAt).getTime();
    if (sinceLast < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000);
      throw Object.assign(new Error(`A code was just sent. Try again in ${wait} second(s).`), {
        code: 'TooManyRequests',
      });
    }
  }

  // The OTP lookup above gives a useful wait time for sequential calls, but it is
  // not a concurrency guard. A shared single-hit cooldown closes the gap when several
  // requests inspect the same empty state at once.
  if (!(await noteHit('otp-cooldown', hmac, 1, RESEND_COOLDOWN_MS))) {
    const wait = Math.ceil(RESEND_COOLDOWN_MS / 1000);
    throw Object.assign(new Error(`A code was just sent. Try again in ${wait} second(s).`), {
      code: 'TooManyRequests',
    });
  }

  // Counted through the shared rolling-window limiter, not from OTP rows. OTP rows
  // expire after five minutes, while this cap must account for the full preceding hour.
  if (!(await noteHit('otp-contact', hmac, MAX_CODES_PER_HOUR, 60 * 60 * 1000))) {
    throw Object.assign(
      new Error('Too many codes requested for that address. Try again in an hour.'),
      { code: 'TooManyRequests' }
    );
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  // A new code retires the old one, so two live codes can never both work.
  await OtpModel.updateMany(
    { contactHmac: hmac, purpose, consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );
  await OtpModel.create({ contactHmac: hmac, purpose, codeHash: hashCode(hmac, code), expiresAt });

  const delivery = await sendCodeByEmail(contact, code);

  return {
    contactMasked: maskEmail(contact),
    expiresInSeconds: Math.round(CODE_TTL_MS / 1000),
    delivered: delivery.delivered,
    provider: delivery.provider,
    // Present only while the mock sender is in use, so a demo does not need a relay
    // account, a verified domain, or published DNS records to be walked through.
    devCode: delivery.provider === 'mock' ? code : undefined,
  };
}

/**
 * Check a code and, if it is right, mint a single-use grant tied to that contact.
 *
 * The grant is what a caller can then use to look up wallets. It is deliberately not a
 * session and deliberately not a key.
 */
export async function verifyCode(rawContact, submitted, purpose = 'enrol') {
  requireDb();

  const contact = normaliseContact(rawContact);
  const hmac = emailHmac(contact);

  const record = await OtpModel.findOne({
    contactHmac: hmac,
    purpose,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!record) {
    throw Object.assign(
      new Error('That code has expired or was never requested. Request a new one.'),
      { code: 'CodeExpired' }
    );
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw Object.assign(
      new Error('Too many wrong guesses on that code. Request a new one.'),
      { code: 'CodeLocked' }
    );
  }

  if (!timingSafeEqual(record.codeHash, hashCode(hmac, String(submitted || '').trim()))) {
    // Compare-and-increment in one database operation. Concurrent wrong guesses
    // cannot overwrite one another's attempt count or pass the five-guess ceiling.
    const attemptAt = new Date();
    const attempted = await OtpModel.findOneAndUpdate(
      {
        _id: record._id,
        contactHmac: hmac,
        purpose,
        consumedAt: null,
        expiresAt: { $gt: attemptAt },
        attempts: { $lt: MAX_ATTEMPTS },
      },
      { $inc: { attempts: 1 } },
      { new: true }
    ).lean();

    if (!attempted) {
      const current = await OtpModel.findById(record._id).lean();
      if (current && !current.consumedAt && current.expiresAt > new Date() && current.attempts >= MAX_ATTEMPTS) {
        throw Object.assign(
          new Error('Too many wrong guesses on that code. Request a new one.'),
          { code: 'CodeLocked' }
        );
      }
      throw Object.assign(
        new Error('That code has expired or was never requested. Request a new one.'),
        { code: 'CodeExpired' }
      );
    }

    const left = MAX_ATTEMPTS - attempted.attempts;
    throw Object.assign(
      new Error(
        left > 0
          ? `That code is not right. ${left} attempt(s) left before it is locked.`
          : 'That code is not right, and it is now locked. Request a new one.'
      ),
      { code: 'CodeInvalid', attemptsLeft: Math.max(0, left) }
    );
  }

  // Only one concurrent correct submission can change an active OTP from unused to
  // consumed. The attempts predicate makes the fifth wrong guess terminal even when
  // a correct request is racing it.
  const consumedAt = new Date();
  const consumed = await OtpModel.findOneAndUpdate(
    {
      _id: record._id,
      contactHmac: hmac,
      purpose,
      codeHash: record.codeHash,
      consumedAt: null,
      expiresAt: { $gt: consumedAt },
      attempts: { $lt: MAX_ATTEMPTS },
    },
    { $set: { consumedAt } },
    { new: true }
  ).lean();
  if (!consumed) {
    const current = await OtpModel.findById(record._id).lean();
    if (current && !current.consumedAt && current.expiresAt > new Date() && current.attempts >= MAX_ATTEMPTS) {
      throw Object.assign(
        new Error('Too many wrong guesses on that code. Request a new one.'),
        { code: 'CodeLocked' }
      );
    }
    throw Object.assign(
      new Error('That code has expired or was never requested. Request a new one.'),
      { code: 'CodeExpired' }
    );
  }

  const token = generateGrantToken();
  await ContactGrantModel.create({
    tokenHash: hashGrantToken(token),
    contactHmac: hmac,
    contactMasked: maskEmail(contact),
    expiresAt: new Date(Date.now() + GRANT_TTL_MS),
  });

  return {
    token,
    contactMasked: maskEmail(contact),
    expiresInSeconds: Math.round(GRANT_TTL_MS / 1000),
  };
}

/**
 * Spend a grant. Single-use, so a replayed token is refused rather than widening the
 * window in which a leaked grant is useful.
 */
export async function consumeGrant(token) {
  requireDb();
  if (!token) {
    throw Object.assign(new Error('A verified contact is required.'), {
      code: 'ContactVerificationRequired',
    });
  }

  const hash = hashGrantToken(String(token));
  const consumedAt = new Date();
  const grant = await ContactGrantModel.findOneAndUpdate(
    {
      tokenHash: hash,
      consumedAt: null,
      expiresAt: { $gt: consumedAt },
    },
    { $set: { consumedAt } },
    { new: true }
  ).lean();

  if (!grant) {
    throw Object.assign(
      new Error('That verification has expired. Verify the address again.'),
      { code: 'ContactVerificationExpired' }
    );
  }

  return { contactHmac: grant.contactHmac, contactMasked: grant.contactMasked };
}
