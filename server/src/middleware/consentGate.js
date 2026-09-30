// THE CONSENT GATE.
//
// The server cannot *be* the viewer — it holds no key — so instead of
// re-implementing the access rule, it asks the contract to run its own check as
// that address:
//
//     eth_call { from: viewer } -> viewRecord(tokenId)
//
// If the call returns, the contract authorised the viewer and we hold the CID it
// released. If it reverts, the contract refused.
//
// Nowhere in this file is there an `if (role === 'admin')`. The rules live in
// Solidity and this module only reports their verdicts. That is the whole point:
// a modified frontend cannot talk its way past an eth_call.
//
// BUT an eth_call proves nothing about who asked for it, and that was a real hole
// for a while: the `viewer` address came straight off the query string, so anyone
// who read a consented address off a block explorer could fetch that address's
// records. requireConsent therefore demands a signature first — see lib/readProof.js.

import { ethers } from 'ethers';
import { callAs, decodeRevert } from '../services/chain.js';
import { verifyReadProof } from '../lib/readProof.js';

const STATUS_FOR = {
  AccessDenied: 403,
  Expired: 403,
  NotAuthorized: 403,
  AccessControlUnauthorizedAccount: 403,
  RecordNotFound: 404,
  ERC721NonexistentToken: 404,
};

const MESSAGE_FOR = {
  AccessDenied: 'The record owner has not granted this viewer access.',
  Expired:
    'The consent window for this viewer has closed. The contract no longer authorises the read.',
  RecordNotFound: 'No record exists for that token id.',
  NotAuthorized: 'The contract refused this call for that address.',
};

/**
 * Ask the contract whether `viewer` may read `tokenId`.
 * Returns `{ ok: true, cid }` or `{ ok: false, status, error, message }`.
 */
export async function checkRead(tokenId, viewer) {
  try {
    const [cid] = await callAs('viewRecord', [tokenId], viewer);
    return { ok: true, cid, checkedBy: 'contract.viewRecord' };
  } catch (error) {
    const decoded = decodeRevert(error);
    if (!decoded) {
      return {
        ok: false,
        status: 502,
        error: 'ChainUnavailable',
        message:
          'Could not reach the contract to check consent. ' +
          (error?.shortMessage || error?.message || 'Unknown RPC error.'),
      };
    }
    return {
      ok: false,
      status: STATUS_FOR[decoded.name] || 403,
      error: decoded.name,
      message: MESSAGE_FOR[decoded.name] || 'The contract refused this read.',
    };
  }
}

function parseTarget(req) {
  const rawTokenId = req.params.tokenId ?? req.body?.tokenId ?? req.query?.tokenId;
  // The header wins, because it is the one the client signs against. The query
  // string is still accepted so existing links and curl examples keep working —
  // but the signature must match whichever value is used, so naming a viewer you
  // do not control gets a 401 rather than a record.
  const viewer =
    req.get?.('x-apnarecord-viewer') ?? req.params.viewer ?? req.body?.viewer ?? req.query?.viewer;
  const tokenId = Number(rawTokenId);

  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return {
      error: {
        status: 400,
        body: { error: 'BadRequest', message: 'tokenId must be a positive integer.' },
      },
    };
  }
  if (typeof viewer !== 'string' || !ethers.isAddress(viewer)) {
    return {
      error: {
        status: 400,
        body: { error: 'BadRequest', message: 'A valid viewer address is required.' },
      },
    };
  }
  return { tokenId, viewer };
}

/**
 * The gate. Two questions, in this order, and both must pass:
 *
 *   1. IS THE CALLER WHO THEY SAY THEY ARE? A signed, structured message over
 *      {tokenId, viewer, issuedAt, nonce}, recovered server-side. Without this the
 *      `viewer` below is just a string anyone can type, and every consented address
 *      is public on-chain — so the gate would be enforceable against addresses and
 *      useless against people.
 *
 *   2. MAY THAT VIEWER READ THIS RECORD? Asked of the contract, which is the only
 *      thing entitled to answer it.
 *
 * Populates `req.consent` with the CID the contract released.
 */
export async function requireConsent(req, res, next) {
  const parsed = parseTarget(req);
  if (parsed.error) return res.status(parsed.error.status).json(parsed.error.body);

  const { tokenId, viewer } = parsed;

  const refused = verifyReadProof({
    tokenId,
    viewer,
    issuedAt: req.get('x-apnarecord-issued-at'),
    nonce: req.get('x-apnarecord-nonce'),
    signature: req.get('x-apnarecord-signature'),
  });
  if (refused) {
    return res.status(401).json({
      error: 'ProofRequired',
      message: refused,
      tokenId,
      viewer,
      howToSign: 'x-apnarecord-issued-at, x-apnarecord-nonce, x-apnarecord-signature',
    });
  }

  const result = await checkRead(tokenId, viewer);

  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      message: result.message,
      tokenId,
      viewer,
    });
  }

  req.consent = { tokenId, viewer, cid: result.cid, checkedBy: result.checkedBy };
  return next();
}
