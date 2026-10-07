// SIGNED STATEMENTS.
//
// Several controllers need the same question answered: "was this statement signed,
// just now, by the address it claims?" There were two copies of this logic and a
// third was about to be written. Three copies is three chances for one to drift, and
// drift here fails open-looking — a version that forgets the freshness window still
// returns null and still looks like it works.
//
// The freshness window is the part worth keeping: without it, a signature is valid
// for ever, and every signed statement ever captured becomes a permanent credential.

import { ethers } from 'ethers';
import { signatureMatchesAddress } from '../services/account.js';
import { claimOnceStrict } from './rateLimit.js';

/** How long a signed statement stays valid. Short, because it is a bearer credential. */
export const STATEMENT_MAX_AGE_MS = 5 * 60 * 1000;

/** Deployment identity shared by all signed writes. */
export function signedWriteDomain() {
  const chainId = Number(process.env.CHAIN_ID);
  const verifyingContract = process.env.CONTRACT_ADDRESS;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('CHAIN_ID must be configured to authorize signed writes.');
  }
  if (!ethers.isAddress(verifyingContract)) {
    throw new Error('CONTRACT_ADDRESS must be configured to authorize signed writes.');
  }
  return { chainId, verifyingContract: ethers.getAddress(verifyingContract) };
}

/**
 * Validate a short-lived signed write. The deadline is capped to the same five
 * minute window used elsewhere, so a caller cannot mint a nonce that stays valid
 * indefinitely. Nonces are bytes32 values and are claimed separately, after any
 * operation-specific authorization checks have passed.
 */
export async function verifyDeadlineMessage({
  message,
  address,
  deadline,
  nonce,
  signature,
  maxFutureMs = STATEMENT_MAX_AGE_MS,
}) {
  const expiry = Number(deadline);
  const remaining = expiry - Date.now();
  if (!Number.isSafeInteger(expiry) || remaining <= 0 || remaining > maxFutureMs) {
    return { error: 'The signed request has expired or its deadline is too far ahead.' };
  }
  if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    return { error: 'The signed request needs a 32-byte nonce.' };
  }
  if (!ethers.isAddress(address)) return { error: 'Not a valid address.' };

  let signer = null;
  try {
    signer = ethers.verifyMessage(message, signature);
  } catch {
    // EIP-1271 account signatures need not be recoverable as an EOA.
  }

  const valid = await signatureMatchesAddress(address, ethers.hashMessage(message), signature);
  if (!valid) {
    return {
      error: signer
        ? `That signature was made by ${signer}, and is not valid for ${ethers.getAddress(address)}.`
        : `That signature is not valid for ${ethers.getAddress(address)}.`,
      signer,
    };
  }
  return {
    signer: signer || ethers.getAddress(address),
    deadline: expiry,
    nonce: nonce.toLowerCase(),
  };
}

/** Spend the verified nonce exactly once across all API instances. */
export async function claimOneUseNonce({ bucket, address, deadline, nonce }) {
  const remaining = Number(deadline) - Date.now();
  if (remaining <= 0) {
    return {
      code: 'SignatureExpired',
      error: 'The signed request expired before it could be applied.',
      status: 403,
    };
  }

  const claimed = await claimOnceStrict(
    bucket,
    `${ethers.getAddress(address).toLowerCase()}:${String(nonce).toLowerCase()}`,
    remaining + 60_000
  );
  if (claimed === null) {
    return {
      code: 'ReplayProtectionUnavailable',
      error: 'One-use signature protection is unavailable while the database is offline.',
      status: 503,
    };
  }
  if (!claimed) {
    return { code: 'SignatureReplay', error: 'This signed request has already been used.', status: 409 };
  }
  return null;
}

/**
 * Validate a personal-message signature for an EOA or an EIP-1271 account.
 * Returns `{ signer }` or `{ error }` with the same freshness behavior as other
 * signed statements.
 */
export async function verifyMessageForAddress({
  message,
  address,
  timestamp,
  signature,
  maxAgeMs = STATEMENT_MAX_AGE_MS,
}) {
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > maxAgeMs) {
    return { error: 'The signature is stale. Refresh the page and try again.' };
  }
  if (!ethers.isAddress(address)) return { error: 'Not a valid address.' };

  let signer = null;
  try {
    signer = ethers.verifyMessage(message, signature);
  } catch {
    // EIP-1271 wallets may support signatures ethers cannot recover as an EOA.
  }

  const valid = await signatureMatchesAddress(address, ethers.hashMessage(message), signature);
  if (!valid) {
    return {
      error: signer
        ? `That signature was made by ${signer}, and is not valid for ${ethers.getAddress(address)}.`
        : `That signature is not valid for ${ethers.getAddress(address)}.`,
      signer,
    };
  }
  return { signer: signer || ethers.getAddress(address) };
}
