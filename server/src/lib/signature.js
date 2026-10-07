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

/** How long a signed statement stays valid. Short, because it is a bearer credential. */
export const STATEMENT_MAX_AGE_MS = 5 * 60 * 1000;

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
