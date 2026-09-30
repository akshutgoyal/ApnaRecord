// GAS, AND WHY A USER NEVER THINKS ABOUT IT.
//
// New wallets are funded at enrolment. This keeps them funded: before a write,
// check the balance, and if it has run low ask the server for a top-up. It is the
// safety net for whoever burns through their allowance — in practice a clinician
// granting access all day, not a patient.
//
// A DUPLICATED WIRE FORMAT, DELIBERATELY. `dripMessage` lives in wireMessages.js and
// must be byte-identical to the one in server/src/controllers/walletController.js. It
// is duplicated rather than imported because the two services deploy separately — the
// server ships from its own root directory, so it cannot reach into client/src, and the
// client must not bundle a server module (it would drag in mongoose). The test suite
// asserts the two strings match exactly.

import { requestDrip } from '../services/api.js';
import { dripMessage } from './wireMessages.js';

/**
 * A courtesy threshold, not the rule.
 *
 * The server applies the real floor and refuses to send when a wallet already has
 * enough, so a mismatch here is harmless — it only decides whether we bother
 * making the request at all. Checked slightly higher than the server's floor so the
 * top-up lands before anything is actually short.
 */
const CLIENT_FLOOR_WEI = 4_000_000_000_000_000n; // 0.004 ETH

/**
 * Ask for a top-up if the account is running low. Never throws: a failed top-up is not
 * a reason to block a write, because the write reports its own honest error if it
 * genuinely cannot pay for itself.
 *
 * The balance checked — and the address funded — is the ACCOUNT, not the signing key.
 * Since records moved to accounts, every write is sent BY the account, so the account is
 * what has to hold gas. A top-up sent to the key would leave the account unable to do
 * anything while looking like it succeeded.
 *
 * The signature still comes from the key, because an account cannot sign. The server
 * verifies that the caller controls the account it is asking to fund.
 */
export async function ensureGas(signer, accountAddress) {
  const address = accountAddress || (await signer.getAddress());
  const balance = await signer.provider.getBalance(address);

  if (balance >= CLIENT_FLOOR_WEI) {
    return { ok: true, skipped: true, reason: 'enough gas', balanceWei: balance.toString() };
  }

  const timestamp = Date.now();
  const signature = await signer.signMessage(dripMessage(address, timestamp));
  return requestDrip(address, { timestamp, signature });
}
