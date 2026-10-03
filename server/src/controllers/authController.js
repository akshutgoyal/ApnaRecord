import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { verifyReadProof } from '../lib/readProof.js';
import { isDbReady, SessionModel } from '../models/index.js';

/**
 * Exchange one read proof for a reusable token.
 *
 * The proof is the same EIP-712 statement the release endpoint uses, with tokenId 0
 * meaning "not about a particular record". It costs one wallet signature; the token it
 * buys covers every gated read for the next ten minutes.
 *
 * Why this exists at all: the proof's nonce is spent against a unique index, so one
 * proof authorises exactly one request. That is the right property for a release, and
 * the wrong one for a page that reads four lists — it would mean four MetaMask prompts
 * per load, and prompts people learn to dismiss.
 *
 * The token is opaque and stores nothing but the viewer. Every request still asks the
 * chain what that viewer may see.
 */
const SESSION_MS = 10 * 60 * 1000;

export async function createSession(req, res) {
  if (!isDbReady()) {
    return res.status(503).json({
      error: 'DatabaseUnavailable',
      message: 'Sessions need the database. Reads will fall back to a signed proof per request.',
    });
  }

  const { viewer, issuedAt, nonce, signature } = req.body || {};

  if (!viewer || !ethers.isAddress(viewer)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid viewer address.' });
  }

  const refused = await verifyReadProof({ tokenId: 0, viewer, issuedAt, nonce, signature });
  if (refused) {
    return res.status(401).json({ error: 'ProofRequired', message: refused, viewer });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MS);

  await SessionModel.create({ token, viewer: ethers.getAddress(viewer), expiresAt });

  return res.json({
    token,
    viewer: ethers.getAddress(viewer),
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: Math.round(SESSION_MS / 1000),
    note: 'Send as `Authorization: Bearer <token>`. Entitlement is still decided per request.',
  });
}
