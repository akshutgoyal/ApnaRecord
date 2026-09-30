// THE DRIPPER.
//
// A small float of Sepolia ETH that lets a user act without ever thinking about
// gas. It exists because the alternative — making people acquire testnet ETH
// before they can grant consent — loses the user at the door.
//
// Three rules shape this file, each learned from a failure mode:
//
//   1. SENDS ARE SERIALISED. One wallet paying many users at once will hand two
//      transactions the same nonce. The second is rejected, the first lands, and
//      the result is a user whose wallet was never funded while the API reported
//      success. Everything goes through one promise chain.
//
//   2. IT NEVER FUNDS AN ADDRESS THAT ALREADY HAS ENOUGH. A funded idle wallet is
//      a wallet someone else can drain, and a dripper's float is the thing an
//      attacker wants. Balances are kept as low as actually works.
//
//   3. IT REFUSES TO START BLIND. If the float cannot cover the cohort, enrolment
//      says so up front instead of accepting users and failing them silently
//      later. A hot wallet that empties quietly is the worst outcome available:
//      signups keep succeeding and writes start failing.

import { ethers } from 'ethers';
import { EnrolmentModel } from '../models/index.js';

const AMOUNT = ethers.parseEther(process.env.DRIP_AMOUNT || '0.01');
const FLOOR = ethers.parseEther(process.env.DRIP_FLOOR || '0.003');
const DAILY_CAP = ethers.parseEther(process.env.DRIP_DAILY_CAP || '1.0');
const LOW_WATER = ethers.parseEther(process.env.DRIP_LOW_WATER || '0.05');

let wallet = null;
let nextNonce = null;
let chain = Promise.resolve();

export function dripEnabled() {
  return Boolean(process.env.DRIPPER_PRIVATE_KEY && process.env.SEPOLIA_RPC_URL);
}

function getWallet() {
  if (wallet) return wallet;
  if (!process.env.SEPOLIA_RPC_URL) throw new Error('SEPOLIA_RPC_URL is not set.');
  if (!process.env.DRIPPER_PRIVATE_KEY) throw new Error('DRIPPER_PRIVATE_KEY is not set.');
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  wallet = new ethers.Wallet(process.env.DRIPPER_PRIVATE_KEY, provider);
  return wallet;
}

/** Run tasks one at a time, in order, whatever happens to any one of them. */
function serialise(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Hand out the next nonce, tracked locally.
 *
 * Asking the node every time is the bug: right after a broadcast, the node still
 * reports the old count, and the next send reuses the nonce.
 */
async function claimNonce() {
  const w = getWallet();
  const onChain = await w.provider.getTransactionCount(w.address, 'pending');

  // NEVER MOVE BACKWARDS.
  //
  // A nonce that is too LOW gets reused, and a reused nonce either replaces a pending
  // transaction or is rejected outright — a stuck queue, and the wallet looks like it is
  // working while nothing settles. A nonce that is too HIGH is merely a gap, which later
  // transactions fill in by themselves. So when the chain and our own count disagree,
  // the higher one wins.
  //
  // This matters most after a failed broadcast, which is precisely when we do not know
  // whether the node accepted the transaction. Re-reading the chain there can hand back
  // a stale value, and taking it at face value would reuse a nonce.
  const next = nextNonce === null ? onChain : Math.max(nextNonce, onChain);
  nextNonce = next + 1;
  return next;
}

async function send(to, value) {
  const w = getWallet();
  try {
    const nonce = await claimNonce();
    const tx = await w.sendTransaction({ to, value, nonce });
    return tx.hash;
  } catch (error) {
    // Deliberately NOT resetting the tracked nonce. A failed broadcast says nothing
    // about whether the node accepted it, and re-reading the chain here is what let a
    // stale value reuse a nonce. Leaving the counter advanced costs us at most a gap.
    throw error;
  }
}

async function spentToday() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await EnrolmentModel.find({ 'drip.at': { $gte: start } })
    .select('drip.amount')
    .lean();
  return rows.reduce((sum, row) => sum + BigInt(row.drip?.amount || '0'), 0n);
}

function warnIfLow(balance) {
  if (balance < LOW_WATER) {
    console.warn(
      `[Dripper] LOW WATER — ${ethers.formatEther(balance)} ETH left. ` +
        `Enrolment stops working once it is gone. Claim more before the next demo.`
    );
  }
}

export async function dripperStatus() {
  if (!dripEnabled()) {
    return {
      enabled: false,
      reason: process.env.SEPOLIA_RPC_URL
        ? 'DRIPPER_PRIVATE_KEY is not set — enrolments cannot be funded.'
        : 'SEPOLIA_RPC_URL is not set.',
    };
  }
  const w = getWallet();
  const balance = await w.provider.getBalance(w.address);
  return {
    enabled: true,
    address: w.address,
    balanceWei: balance.toString(),
    balanceEth: ethers.formatEther(balance),
    amountWei: AMOUNT.toString(),
    amountEth: ethers.formatEther(AMOUNT),
    floorEth: ethers.formatEther(FLOOR),
    lowWaterEth: ethers.formatEther(LOW_WATER),
    dailyCapEth: ethers.formatEther(DAILY_CAP),
    low: balance < LOW_WATER,
    // How many more enrolments this float can cover. The single most useful number
    // to have on a screen before a demo.
    enrolmentsRemaining: Number(balance / AMOUNT),
  };
}

/**
 * Fund an address if it needs it. Returns what happened rather than throwing, so
 * an enrolment can still succeed when the drip is skipped — the wallet is created
 * either way, and a user with a wallet but no gas is a recoverable state.
 */
export async function ensureFunded(address, { reason = 'enrolment' } = {}) {
  if (!dripEnabled()) {
    return { ok: false, skipped: true, reason: 'dripper not configured' };
  }

  return serialise(async () => {
    const w = getWallet();
    const balance = await w.provider.getBalance(address);

    if (balance >= FLOOR) {
      return { ok: true, skipped: true, reason: 'already funded', balanceEth: ethers.formatEther(balance) };
    }

    const spent = await spentToday();
    if (spent + AMOUNT > DAILY_CAP) {
      console.warn(
        `[Dripper] Daily cap reached (${ethers.formatEther(spent)} spent). ` +
          `Refusing to fund ${address}.`
      );
      return { ok: false, skipped: true, reason: 'daily cap reached', spentEth: ethers.formatEther(spent) };
    }

    const floatBalance = await w.provider.getBalance(w.address);
    if (floatBalance < AMOUNT) {
      warnIfLow(floatBalance);
      return {
        ok: false,
        skipped: true,
        reason: 'the dripper is empty',
        balanceEth: ethers.formatEther(floatBalance),
      };
    }

    const txHash = await send(address, AMOUNT);
    warnIfLow(floatBalance - AMOUNT);

    if (reason === 'top-up') {
      await EnrolmentModel.updateOne({ address: address.toLowerCase() }, { $inc: { 'drip.topUps': 1 } });
    }
    await EnrolmentModel.updateOne(
      { address: address.toLowerCase() },
      { $set: { 'drip.amount': AMOUNT.toString(), 'drip.txHash': txHash, 'drip.at': new Date() } }
    );

    console.log(`[Dripper] Sent ${ethers.formatEther(AMOUNT)} ETH to ${address} (${txHash})`);
    return { ok: true, skipped: false, txHash, amountEth: ethers.formatEther(AMOUNT) };
  });
}
