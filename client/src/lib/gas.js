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
 * How long to wait for a top-up to land, and how often to look.
 *
 * THIS IS THE WHOLE DIFFICULTY. Not waiting at all — which is what this used to do —
 * means the write races the top-up and loses, and the user sees "insufficient funds" on
 * a wallet the app had just promised to fund. Waiting forever means one stuck
 * transaction freezes the interface, because the browser is holding a button that will
 * never resolve.
 *
 * So: long enough for a Sepolia round-trip, short enough that giving up is still a
 * responsive thing to have done. If it has not landed in thirty seconds it is not going
 * to rescue this write, and the write's own error is more honest than a spinner.
 */
const TOPUP_WAIT_MS = 30_000;
const POLL_MS = 2_000;

/**
 * Ask for a top-up if the account is running low, and wait a bounded time for it.
 *
 * Never throws. A top-up that fails is not a reason to block a write: the write reports
 * its own honest error if it genuinely cannot pay for itself, and that error is more
 * useful than one from the funding step.
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
  const provider = signer.provider;

  const before = await provider.getBalance(address);
  if (before >= CLIENT_FLOOR_WEI) {
    return { ok: true, skipped: true, reason: 'enough gas', balanceWei: before.toString() };
  }

  const timestamp = Date.now();
  const signature = await signer.signMessage(dripMessage(address, timestamp));

  let requested;
  try {
    requested = await requestDrip(address, { timestamp, signature });
  } catch (error) {
    // Asked and refused — a spent per-contact allowance, or a float that is out. Say so
    // and let the write proceed; it may still succeed on what the account already holds.
    return {
      ok: false,
      waitedMs: 0,
      reason: error?.message || String(error),
      balanceWei: before.toString(),
    };
  }

  const started = Date.now();
  let balance = before;

  while (Date.now() - started < TOPUP_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      balance = await provider.getBalance(address);
    } catch {
      // A provider hiccup mid-wait is not a reason to stop waiting; the next poll may
      // well succeed, and the deadline bounds it either way.
      continue;
    }
    if (balance >= CLIENT_FLOOR_WEI) {
      return {
        ok: true,
        waitedMs: Date.now() - started,
        balanceWei: balance.toString(),
        txHash: requested?.txHash || null,
      };
    }
  }

  return {
    ok: false,
    waitedMs: Date.now() - started,
    reason: `the top-up did not land within ${Math.round(TOPUP_WAIT_MS / 1000)}s`,
    balanceWei: balance.toString(),
    txHash: requested?.txHash || null,
    stillPending: true,
  };
}
