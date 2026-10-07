// ABUSE CONTROLS THAT SURVIVE A RESTART.
//
// These replace three `Map`s that lived in controllers. Keeping them in memory was
// the kind of choice that reads as fine and behaves as broken: the counters emptied
// on every deploy and every crash-loop, and two instances each kept their own, so
// running a second instance silently doubled everyone's allowance.
//
// Abuse counters fail open during a database outage because they are not the
// authorization boundary. One-use signed-write claims are different: they fail closed
// through `claimOnceStrict`, because a replay guard without a shared store is no guard.

import { RateLimitBucketModel, OneShotModel, isDbReady } from '../models/index.js';

/**
 * Record one hit in an atomic rolling window. Returns false when the number of
 * accepted hits in the window has reached `limit`.
 *
 * `bucket` names the control ("otp-ip", "lookup-ip"); `key` is who it applies to.
 * Together they identify a shared row. The update pipeline prunes old hits and
 * conditionally appends the current one in a single document update, so concurrent
 * requests across instances cannot count the same pre-insert state.
 */
export async function noteHit(bucket, key, limit, windowMs) {
  if (!isDbReady()) return true;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('Rate limit capacity and window must be positive.');
  }

  const now = new Date();
  const pipeline = [
    {
      $set: {
        _effectiveNow: {
          $max: [{ $ifNull: ['$updatedAt', { $literal: now }] }, { $literal: now }],
        },
      },
    },
    {
      $set: {
        _recentHits: {
          $filter: {
            input: { $ifNull: ['$hits', []] },
            as: 'hit',
            cond: { $gte: ['$$hit', { $subtract: ['$_effectiveNow', windowMs] }] },
          },
        },
      },
    },
    {
      $set: {
        _allowed: { $lt: [{ $size: '$_recentHits' }, limit] },
      },
    },
    {
      $set: {
        allowed: '$_allowed',
        hits: {
          $cond: [
            '$_allowed',
            { $concatArrays: ['$_recentHits', ['$_effectiveNow']] },
            '$_recentHits',
          ],
        },
        updatedAt: '$_effectiveNow',
        expiresAt: { $add: ['$_effectiveNow', windowMs] },
      },
    },
    { $unset: ['_effectiveNow', '_recentHits', '_allowed'] },
  ];

  // A simultaneous first request may race to upsert the unique row. The loser
  // retries against the winner's row and atomically counts against its hit window.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const state = await RateLimitBucketModel.findOneAndUpdate(
        { bucket, key },
        pipeline,
        { upsert: true, new: true }
      ).lean();
      return Boolean(state?.allowed);
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  // Sustained index contention is refused rather than allowed to bypass the limit.
  return false;
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

/**
 * Claim a security-sensitive one-use nonce. Unlike abuse controls, this must fail
 * closed when the database is unavailable: without the unique index there is no
 * replay protection to rely on.
 *
 * Returns true when claimed, false for a duplicate, and null when Mongo is not ready.
 */
export async function claimOnceStrict(bucket, key, ttlMs) {
  if (!isDbReady()) return null;

  try {
    await OneShotModel.create({
      bucket,
      key,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}
