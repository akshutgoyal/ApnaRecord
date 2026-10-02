import { ethers } from 'ethers';
import { EnrolmentModel, isDbReady } from '../models/index.js';
import { call } from '../services/chain.js';

/**
 * WHO HAS SIGNED UP BUT NOT BEEN GIVEN AN IDENTITY.
 *
 * Enrolment deploys an account and writes a database row. It does NOT touch the contract's
 * identity registry — deliberately, because `createIdentity` is an administrator's act and
 * the server holds no key that could make it. The consequence is that a new user arrives
 * with a wallet, no role, and nobody told. The console tells THEM to wait for an
 * administrator, who has no way to learn there is anything to wait for. This closes that.
 *
 * THE DATABASE CANNOT ANSWER THIS ON ITS OWN. `EnrolmentModel` knows the account and the
 * masked email but nothing about chain state, and `IdentityModel` is only populated by the
 * mirror write that happens AFTER an identity exists. So each candidate is checked against
 * the chain.
 *
 * One call per enrolment: fine at demo scale, and it would want a cache beyond that. The
 * fan-out is bounded by chain.js's concurrency limit, which exists because the public RPC
 * drops concurrent calls — without it this endpoint would take the whole dashboard with it.
 *
 * SIGNATURE-GATED, unlike the rest of the directory. Those reads are unauthenticated by
 * decision, but a masked email address is not public data: an open list here would let
 * anyone enumerate who has signed up. The signer must hold DEFAULT_ADMIN_ROLE.
 */

/** Must stay byte-identical to `pendingMessage` in client/src/lib/wireMessages.js. */
export function pendingMessage(timestamp) {
  return 'ApnaRecord read pending registrations\n' + `timestamp: ${timestamp}`;
}

/** Five minutes — long enough for a slow page, short enough that a captured signature ages out. */
const MAX_AGE_MS = 5 * 60 * 1000;

/** How many enrolments to check. The chain read is the cost, so this stays bounded. */
const MAX_CANDIDATES = 25;

async function isAdmin(address) {
  const [role] = await call('DEFAULT_ADMIN_ROLE');
  const [has] = await call('hasRole', [role, address]);
  return Boolean(has);
}

export async function pendingRegistrations(req, res) {
  if (!isDbReady()) {
    return res.status(503).json({
      error: 'DatabaseUnavailable',
      message: 'The database is offline, so enrolments cannot be listed.',
    });
  }

  const timestamp = req.get('x-apnarecord-timestamp');
  const signature = req.get('x-apnarecord-signature');

  if (!timestamp || !signature) {
    return res.status(401).json({
      error: 'SignatureRequired',
      message:
        'This lists masked email addresses, so it needs a statement signed by an administrator.',
    });
  }

  // `Math.abs` because a clock running fast is as wrong as one running slow, and a future
  // timestamp would otherwise never expire.
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
    return res.status(401).json({
      error: 'SignatureExpired',
      message: 'That signature is outside the five-minute window.',
    });
  }

  let signer;
  try {
    signer = ethers.verifyMessage(pendingMessage(timestamp), signature).toLowerCase();
  } catch {
    return res.status(401).json({ error: 'SignatureInvalid', message: 'That signature could not be read.' });
  }

  try {
    if (!(await isAdmin(signer))) {
      return res.status(403).json({
        error: 'NotAuthorized',
        message: `${signer} does not hold DEFAULT_ADMIN_ROLE, so it may not list registrations.`,
      });
    }

    // Newest first, and bounded — the chain call per row is the cost, not the query.
    const rows = await EnrolmentModel.find({})
      .sort({ createdAt: -1 })
      .limit(MAX_CANDIDATES)
      .select('address owner identity.emailMasked createdAt requestedRole')
      .lean();

    const pending = [];
    for (const row of rows) {
      // `identities()` returns a struct; index 1 is `active`, index 2 is `facility`.
      const [identity] = await call('identities', [row.address]);
      // A read that returned NOTHING is not the same as an identity that does not exist.
      // A missing identity is a zeroed struct, not an absent one, so treating the two alike
      // would list every enrolled wallet as unregistered the moment the RPC gaped -- which is
      // the same confident-wrong answer the dashboards produced.
      if (!identity) {
        return res.status(503).json({
          error: 'ChainUnavailable',
          message: 'Could not read the identity registry, so the waiting list cannot be trusted.',
        });
      }
      // `active` by name, falling back to the index. ethers answers to both ONLY when the
      // ABI names its struct components; reading the wrong one yields undefined, which is
      // falsy, so every candidate looked unregistered and the list never cleared however
      // many assignments had landed.
      if ((identity.active ?? identity[1] ?? false)) continue;

      pending.push({
        address: row.address,
        owner: row.owner,
        emailMasked: row.identity?.emailMasked || '',
        requestedRole: row.requestedRole || '',
        enrolledAt: row.createdAt,
      });
    }

    return res.json({
      pending,
      // Named so the caller can tell "nobody is waiting" from "we stopped looking".
      checked: rows.length,
      limit: MAX_CANDIDATES,
      truncated: rows.length === MAX_CANDIDATES,
    });
  } catch (error) {
    return res.status(502).json({
      error: 'PendingUnavailable',
      message: `Could not check the chain: ${error.message}`,
    });
  }
}
