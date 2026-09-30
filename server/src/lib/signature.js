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

/** How long a signed statement stays valid. Short, because it is a bearer credential. */
export const STATEMENT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Recover who signed, without saying who they had to be.
 *
 * Needed because one caller — storing a record's bytes before it is minted — cannot
 * name the signer in advance; it has to recover them and then ask the contract
 * whether they hold the role that permits the action.
 *
 * Returns `{ signer }` or `{ error }`.
 */
export function recoverStatement({
  message,
  timestamp,
  signature,
  maxAgeMs = STATEMENT_MAX_AGE_MS,
}) {
  if (!timestamp || !signature) {
    return { error: 'A signed statement from the wallet is required.' };
  }

  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > maxAgeMs) {
    return { error: 'The signature is stale. Refresh the page and try again.' };
  }

  try {
    return { signer: ethers.verifyMessage(message, signature) };
  } catch {
    return { error: 'That signature could not be read.' };
  }
}

/**
 * Returns null when the statement is good, or a plain-language reason when it is not.
 * The message is the caller's job — it must match, byte for byte, whatever the client
 * signed, which is why the wire formats live in one place on each side and a test
 * asserts they agree.
 */
export function verifyStatement({ message, address, timestamp, signature, maxAgeMs }) {
  const result = recoverStatement({ message, timestamp, signature, maxAgeMs });
  if (result.error) return result.error;

  if (!ethers.isAddress(address)) {
    return 'Not a valid address.';
  }

  if (result.signer.toLowerCase() !== address.toLowerCase()) {
    return `That signature was made by ${result.signer}, not by ${ethers.getAddress(address)}.`;
  }

  return null;
}
