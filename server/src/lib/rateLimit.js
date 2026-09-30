// ABUSE CONTROLS THAT SURVIVE A RESTART.
//
// These replace three `Map`s that lived in controllers. Keeping them in memory was
// the kind of choice that reads as fine and behaves as broken: the counters emptied
// on every deploy and every crash-loop, and two instances each kept their own, so
// running a second instance silently doubled everyone's allowance.
//
// A NOTE ON FAILING OPEN. Every function here returns "allowed" when the database is
// unreachable. That is deliberate and it is a real trade, so it is worth stating
// plainly: these are abuse controls, not authorisation. If Mongo is down, refusing
// every request would convert a database outage into a total outage, and the limits
// they enforce are the difference between someone being annoying and someone being
// expensive. The check that actually protects a record is the signature check, and
// that never fails open.

import { RateLimitModel, OneShotModel, isDbReady } from '../models/index.js';

/**
 * Count one hit against a window. Returns true while the caller is still within the
 * limit, false once they are over it.
 *
 * `bucket` names the control ("otp-ip", "lookup-ip"); `key` is who it applies to.
 * Together they are the identity of the window.
 */
export async function noteHit(bucket, key, limit, windowMs) {
  if (!isDbReady()) return true;

  const since = new Date(Date.now() - windowMs);
  const used = await RateLimitModel.countDocuments({ bucket, key, at: { $gte: since } });
  if (used >= limit) return false;

  await RateLimitModel.create({
    bucket,
    key,
    at: new Date(),
    // The TTL index removes the row for us. It is set to the end of the window, so
    // anything older than a window cannot count towards it and is safe to drop.
    expiresAt: new Date(Date.now() + windowMs),
  });
  return true;
}

/** How many hits are inside the window right now, without recording one. */
export async function hitsInWindow(bucket, key, windowMs) {
  if (!isDbReady()) return 0;
  return RateLimitModel.countDocuments({ bucket, key, at: { $gte: new Date(Date.now() - windowMs) } });
}

/**
 * Claim a value that may be spent once. Returns true if this call claimed it, false
 * if it had already been claimed.
 *
 * The uniqueness comes from a unique index, so two simultaneous claims cannot both
 * win — which is exactly the property a replay guard needs, since a replay racing the
 * original is the case that matters.
 */
export async function claimOnce(bucket, key, ttlMs) {
  if (!isDbReady()) {
    // Without the database there is nothing to be unique against. Allowing the read
    // through is consistent with failing open, and the signature check still ran.
    return true;
  }

  try {
    await OneShotModel.create({
      bucket,
      key,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return true;
  } catch (error) {
    // 11000 is a duplicate key. Anything else is a real problem and must not be
    // reported as "already used", which would look like a replay to the caller.
    if (error?.code === 11000) return false;
    throw error;
  }
}
