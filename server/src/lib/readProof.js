// PROOF OF VIEWER.
//
// Closes the hole the consent gate left open. Until this existed, the gate did:
//
//     eth_call { from: <viewer from the query string> } -> viewRecord(tokenId)
//
// The contract's rule was enforced — but the *identity of the reader* was merely
// asserted by the caller. Consented addresses are public on-chain, so anyone who
// read one off a block explorer could fetch that address's records by naming it.
// The gate stopped an unauthorised address, never an unauthorised person.
//
// So a read now requires a signature the caller must produce, over a structured
// message that binds three things: which record, which viewer, and when. The
// server recovers the signer and requires it to be the viewer — and only then
// asks the contract. The contract still decides; this decides *who is asking*.
//
// A note on why the message is structured (EIP-712) rather than a plain string.
// The user sees what they are authorising in their wallet, the fields are typed,
// and the domain binds the signature to this contract and this chain — so a
// signature harvested here cannot be replayed against a different deployment.

import { ethers } from 'ethers';
import { claimOnce } from './rateLimit.js';

/** How long a signed read stays valid. Short, because it is a bearer token. */
const MAX_AGE_MS = 5 * 60 * 1000;

const CHAIN_ID = Number(process.env.CHAIN_ID) || 11155111;

export const READ_DOMAIN = () => ({
  name: 'ApnaRecord',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: process.env.CONTRACT_ADDRESS,
});

export const READ_TYPES = {
  RecordRead: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'viewer', type: 'address' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/**
 * Replay guard.
 *
 * A UNIQUE index in the database, not a `Map` in this process. The in-memory version
 * forgot every spent signature when the server restarted, and each instance kept its
 * own list — so a replay only had to wait for a deploy, or land on the other
 * instance. The blast radius of a replay is small (it re-reads a record the viewer
 * was already entitled to read), which is why it was acceptable then; it is not a
 * reason to leave it that way now.
 */

/**
 * Returns null when the proof is good, or a plain-language reason when it is not.
 * The message matters: a caller who forgot to sign needs to know that, not to be
 * told "403".
 *
 * Async because the replay guard lives in the database. The contract read that
 * follows is asynchronous anyway, so this costs nothing.
 */
export async function verifyReadProof({ tokenId, viewer, issuedAt, nonce, signature }) {
  const now = Date.now();

  // Checked before anything else, because the failure it prevents is invisible: with
  // the contract address unset the domain hashes to something the client never
  // signed, so every read is refused as if the signature were forged. That would
  // look like a permissions bug and cost an afternoon.
  if (!process.env.CONTRACT_ADDRESS) {
    return (
      'The server is misconfigured: CONTRACT_ADDRESS is not set, so read signatures ' +
      'cannot be verified against the deployed contract.'
    );
  }

  const missing = [];
  if (!issuedAt) missing.push('x-apnarecord-issued-at');
  if (!nonce) missing.push('x-apnarecord-nonce');
  if (!signature) missing.push('x-apnarecord-signature');
  if (missing.length) {
    return (
      'This record is released only to a caller who proves they hold the viewer key. ' +
      `Missing header(s): ${missing.join(', ')}.`
    );
  }

  const age = now - Number(issuedAt);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
    return 'The read signature is stale. Sign again and retry.';
  }

  if (!ethers.isHexString(nonce, 32)) {
    return 'x-apnarecord-nonce must be a 32-byte hex value.';
  }

  if (!ethers.isAddress(viewer)) {
    return 'A valid viewer address is required before a signature can be checked.';
  }

  let recovered;
  try {
    recovered = ethers.verifyTypedData(
      READ_DOMAIN(),
      READ_TYPES,
      { tokenId, viewer: ethers.getAddress(viewer), issuedAt: Number(issuedAt), nonce },
      signature
    );
  } catch {
    return 'That read signature could not be read.';
  }

  if (recovered.toLowerCase() !== viewer.toLowerCase()) {
    return (
      `That read signature was made by ${recovered}, not by the viewer it claims to be ` +
      `(${ethers.getAddress(viewer)}).`
    );
  }

  // Claimed by unique index, so two simultaneous replays cannot both win — which is
  // the case that matters, since a replay racing the original is the whole attack.
  const claimed = await claimOnce(
    'read-nonce',
    `${recovered.toLowerCase()}:${nonce}`,
    MAX_AGE_MS
  );
  if (!claimed) {
    return 'That read signature has already been used. Sign again.';
  }

  return null;
}
