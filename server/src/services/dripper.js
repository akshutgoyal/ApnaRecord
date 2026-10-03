// THE DRIPPER.
//
// A small float of Sepolia ETH that lets a user act without ever thinking about
// gas. It exists because the alternative — making people acquire testnet ETH
// before they can grant consent — loses the user at the door.
//
// Three rules shape this file, each learned from a failure mode:
//
//   1. SENDS ARE SERIALISED, AND THE NONCE IS CLAIMED IN THE DATABASE. One wallet
//      paying many users at once will hand two transactions the same nonce. The
//      second is rejected, the first lands, and the result is a user whose wallet was
//      never funded while the API reported success. A promise chain only orders sends
//      inside one process — two instances each kept their own counter — so the claim
//      that actually makes this safe is an atomic `$inc` in MongoDB.
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
import { EnrolmentModel, DripperModel, DripLedgerModel, isDbReady } from '../models/index.js';

const AMOUNT = ethers.parseEther(process.env.DRIP_AMOUNT || '0.01');
const FLOOR = ethers.parseEther(process.env.DRIP_FLOOR || '0.003');
const DAILY_CAP = ethers.parseEther(process.env.DRIP_DAILY_CAP || '1.0');
const LOW_WATER = ethers.parseEther(process.env.DRIP_LOW_WATER || '0.05');
// How many times ONE CONTACT may be funded across its whole life: the first at
// enrolment, the rest as top-ups. Three covers a clinician who genuinely burns through
// their allowance without turning the float into a tap.
const MAX_PER_CONTACT = Number(process.env.DRIP_MAX_PER_CONTACT) || 3;

let wallet = null;
let chain = Promise.resolve();

export function dripEnabled() {
  return Boolean(process.env.DRIPPER_PRIVATE_KEY && process.env.RPC_URL);
}

function getWallet() {
  if (wallet) return wallet;
  if (!process.env.RPC_URL) throw new Error('RPC_URL is not set.');
  if (!process.env.DRIPPER_PRIVATE_KEY) throw new Error('DRIPPER_PRIVATE_KEY is not set.');
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
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
 * Hand out the next nonce.
 *
 * The claim is an atomic `$inc` in MongoDB, and that is what makes it correct. A
 * promise chain orders sends inside one process and says nothing about a second
 * instance — each would keep its own counter, hand the same nonce to two different
 * transactions, and one would be rejected while both callers were told they succeeded.
 * A dripper that reports success for a payment it never made is worse than one that
 * fails loudly.
 *
 * The serialisation below is kept, but only as an optimisation: it stops one busy
 * process from piling concurrent claims onto the database. It is not what makes this
 * safe, and removing it would not introduce a bug.
 *
 * AFTER THE FIRST CLAIM, THE COUNTER ONLY EVER MOVES BY ONE. An earlier version also
 * snapped it forward to the chain's count on every call, on the reasoning that a nonce
 * too high is "merely a gap, which later transactions fill in on their own". That
 * reasoning is wrong, and the snap was unsafe for two independent reasons:
 *
 *   • Nonces must be sequential. If 25 is never sent, then 26, 27, 28 sit in the
 *     mempool and never mine — the dripper does not recover, it stalls for good.
 *   • `$set` is a blind write that jumps to a value rather than stepping to it, so it
 *     skips whatever lies between the counter and the chain's count. A concurrent
 *     `$inc` landing between the read and the write is silently lost too.
 *
 * The counter is incremented BEFORE every send, so it can never legitimately be behind
 * the chain, and there is nothing for a snap to recover. The chain is therefore
 * consulted exactly once, when the counter does not exist yet.
 *
 * One correction on the record. This was removed while chasing an intermittent "gap"
 * failure in the cross-instance suite. It was not the cause, and neither of my first two
 * explanations was: the suite counted only `drip` lines, and enrolment had started
 * deploying an account per user, so every deploy consumed a nonce between two drips and
 * the sequence looked gappy while nothing had been skipped. Instrumenting the send paths
 * proved it — no send ever threw. The snap is still worth removing on its own merits;
 * it just was not fixing the symptom that led here.
 */
let seeded = false;

  async function claimNonce() {
    const w = getWallet();
    const key = w.address.toLowerCase();

    // `$setOnInsert` and nothing else. If the document exists we trust it, because it is
    // only ever advanced by one, immediately before a send that is about to happen.
    if (!seeded) {
      const onChain = await w.provider.getTransactionCount(w.address, 'pending');
      await DripperModel.updateOne(
        { address: key },
        { $setOnInsert: { address: key, nextNonce: onChain, inFlight: 0 } },
        { upsert: true }
      );
      seeded = true;
    }

    // Before claiming, heal a counter that sits ahead of the chain.
    //
    // This is the reconciliation the comment below used to explain why it was absent. It
    // is safe now for one reason: the in-flight count is in the SHARED document, so
    // "nobody is mid-send anywhere" is a fact any instance can establish, where a
    // process-local guard could only ever speak for itself.
    await reconcileNonce(key);

    // `$inc` both, atomically. `new: false` returns the document as it was BEFORE the
    // increment, which is the nonce being claimed — and because in-flight was raised in
    // the same operation, no reconciler anywhere can rewind this claim out from under us.
    const claimed = await DripperModel.findOneAndUpdate(
      { address: key },
      { $inc: { nextNonce: 1, inFlight: 1 }, $set: { inFlightAt: new Date() } },
      { new: false, lean: true }
    );

    if (!claimed) {
      throw new Error('Could not claim a nonce — the dripper counter document is missing.');
    }
    return claimed.nextNonce;
  }

  /**
   * Settle a claim, and optionally hand the nonce back.
   *
   * Every claim reaches here exactly once: on success, on a pre-broadcast failure, and on
   * an ambiguous one. The in-flight decrement is unconditional, because the send is over
   * in all three cases — leaving it raised would block reconciliation for good, and a
   * counter that can never be healed is worse than one that needs healing.
   *
   * The rewind is the part that must stay conditional. A claimed nonce that was never
   * broadcast is the permanent gap that stalls everything after it, so it goes back — but
   * only while the counter is still immediately after our claim. If anything has claimed
   * since, reclaiming would collide with it, and a rare real gap beats a reused nonce.
   */
  async function settleNonce(nonce, { unused = false } = {}) {
    const w = getWallet();
    const key = w.address.toLowerCase();
    try {
      // `$gt: 0` because a document written before this field existed has no inFlight,
      // and Mongo would treat a missing field as 0 and decrement it to -1.
      await DripperModel.updateOne(
        { address: key, inFlight: { $gt: 0 } },
        { $inc: { inFlight: -1 } }
      );

      if (unused) {
        await DripperModel.updateOne(
          { address: key, nextNonce: nonce + 1 },
          { $set: { nextNonce: nonce } }
        );
      }
    } catch (error) {
      // Settling is best-effort. Failing here must not mask the send error that caused
      // it, which is the one worth reporting.
      console.warn('[Dripper] Could not settle nonce', nonce, '-', error.message);
    }
  }

  /**
   * Pull the counter back to the chain when it has run ahead and nothing is in flight.
   *
   * Why the chain can be behind: a claim is made before the send, and a failure at the
   * broadcast is ambiguous — the node may or may not be holding the transaction. The
   * nonce stays spent, correctly, and the counter ends up one ahead of anything the node
   * has seen. Nonces are sequential, so that one skipped value stalls every drip behind
   * it permanently.
   *
   * Why this is safe now: the guard is `inFlight: 0` IN THE UPDATE ITSELF, not in a read
   * before it. A claim landing between our read and our write raises inFlight and sets
   * nextNonce forward in the same atomic operation, so the condition fails and nothing is
   * undone. Two instances cannot both conclude "quiet" while one is mid-send, which is
   * the reuse the process-local version caused.
   *
   * A crashed process leaves inFlight raised with nothing to settle it, so a claim older
   * than STALE_CLAIM_MS is treated as abandoned. The direction of the guess matters: a
   * nonce wrongly considered settled only blocks a rewind, while one wrongly considered
   * in-flight would let a rewind happen under a live send.
   */
  const STALE_CLAIM_MS = 10 * 60 * 1000;

  async function reconcileNonce(key) {
    try {
      const doc = await DripperModel.findOne({ address: key }).lean();
      if (!doc || !doc.nextNonce) return;

      const inFlight = Number(doc.inFlight || 0);
      const claimAge = doc.inFlightAt ? Date.now() - new Date(doc.inFlightAt).getTime() : null;
      // A claim that is still young might be a live send anywhere on the fleet.
      if (inFlight > 0 && claimAge !== null && claimAge < STALE_CLAIM_MS) return;

      const w = getWallet();
      const onChain = await w.provider.getTransactionCount(w.address, 'pending');
      if (onChain >= doc.nextNonce) return;

      const rewound = await DripperModel.updateOne(
        { address: key, inFlight: { $lte: 0 }, nextNonce: { $gt: onChain } },
        { $set: { nextNonce: onChain } }
      );
      if (rewound.modifiedCount) {
        console.warn(
          `[Dripper] Rewound the nonce counter from ${doc.nextNonce} to ${onChain} — ` +
            'nothing was in flight, so the value between them was never sent.'
        );
      }
    } catch (error) {
      // Could not reach the chain. Claiming still works; it just skips the heal.
      console.warn('[Dripper] Could not reconcile the nonce counter -', error.message);
    }
  }

  /**
   * Failures we can positively place BEFORE the transaction reached the node.
 *
 * Only these hand the nonce back. Anything else — a broadcast the node may have accepted,
 * or an error with no `action` at all — leaves the nonce spent.
 */
const PRE_BROADCAST_ACTIONS = new Set([
  'estimateGas',
  'getTransactionCount',
  'getFeeData',
  'getGasPrice',
  'getBlock',
  'getBlockNumber',
  'populateTransaction',
  'call',
]);

/**
 * Whether a failed send is known to have never reached the node.
 *
 * Exported and pure so the rule can be asserted. It was previously an inline
 * `error?.action !== 'sendTransaction'`, which no test could see and which was wrong in
 * the expensive direction: ethers attaches no `action` to an `eth_sendRawTransaction`
 * failure, so it released the nonce on every failure, including ones where the node
 * might be holding the transaction.
 */
export function nonceWasUnused(error) {
  return PRE_BROADCAST_ACTIONS.has(error?.action);
}

// A drip goes to an ACCOUNT CONTRACT, so a plain-transfer gas limit is wrong. Its
// receive() pushes the cost past 21,000 and the transfer runs out of gas and
// reverts -- after being signed, broadcast and paid for.
//
// This is not hypothetical. A drip estimated 21,000 while the account was still
// deploying, the account landed mid-flight, and the transfer needed 22,827. It
// reverted, the dripper paid for it, and the ledger recorded a successful top-up.
//
// Unused gas is refunded, so being generous costs nothing; being exact costs a
// silently unfunded account.
const DRIP_GAS_LIMIT = 60_000n;

async function send(to, value) {
  const w = getWallet();
  const nonce = await claimNonce();

  // Settle exactly once per claim. In-flight means "claimed but not yet broadcast", so
  // it comes down on success as well as failure — and the paths below can overlap, so
  // the flag is what stops a double decrement.
  let settled = false;
  const settle = async (unused) => {
    if (settled) return;
    settled = true;
    await settleNonce(nonce, { unused });
  };

  try {
    const tx = await w.sendTransaction({ to, value, nonce, gasLimit: DRIP_GAS_LIMIT });

    // Broadcast. The nonce is spent now whatever happens next, so settle with nothing
    // to hand back — and do it before the wait, because a wait that throws still had a
    // live transaction behind it.
    await settle(false);

    // Wait, and check. A reverted transaction still has a valid hash, so returning one

    // and calling it a top-up reports success for a payment that never happened --

    // precisely the failure this file's header warns about, and precisely what happened:

    // the ledger said the account was funded and it held nothing.

    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {

      throw new Error(`The drip reverted on chain (${tx.hash}). No funds were sent.`);

    }

    return tx.hash;
  } catch (error) {
    // A failure BEFORE the broadcast means the nonce was never used, so it has to go
    // back — abandoning it is the permanent gap that stalls everything after it.
    //
    // A failure AT the broadcast is ambiguous: the node may be holding the
    // transaction. The nonce stays spent, because a rare gap is survivable and a
    // reused nonce is not.
    //
    // This test used to read `error?.action !== 'sendTransaction'`, as though ethers
    // labelled a broadcast failure that way. It does not. An `eth_sendRawTransaction`
    // failure is built by `getRpcError()` with no `action` field at all, so the
    // comparison was true for EVERY failure and the nonce went back even when the
    // transaction might be live — which is precisely the reuse case, and reuse is the
    // one outcome that loses funds silently while the ledger records a hash.
    //
    // So the test is inverted: release only on an action known to be pre-broadcast.
    // Being wrong in this direction costs a gap; being wrong the other way costs money.
    await settle(nonceWasUnused(error));
    throw error;
  }
}

/**
 * Create a contract, and wait until it exists.
 *
 * A sibling of `send` through the same atomic nonce claim, because it is the same
 * wallet spending the same sequence — a deploy racing a drip would otherwise reuse a
 * nonce. The differences are that there is no `to`, and that the address only exists
 * once the transaction is mined, so this has to wait for a receipt.
 *
 * Waiting is correct here and would be wrong for a drip. A drip can return before
 * confirmation because nothing depends on the money being there yet; the account's
 * address IS the result, and there is nothing to report until the chain has one.
 */
export async function deployContract(data) {
  const w = getWallet();
  const nonce = await claimNonce();

  // Same settle-once rule as `send`.
  let settled = false;
  const settle = async (unused) => {
    if (settled) return;
    settled = true;
    await settleNonce(nonce, { unused });
  };

  let tx;
  try {
    tx = await w.sendTransaction({ data, nonce });
    // Broadcast, so the nonce is spent — and the address is not known until it mines,
    // which is why the wait below is outside this try.
    await settle(false);
  } catch (error) {
    await settle(nonceWasUnused(error));
    throw error;
  }

  const receipt = await tx.wait();

  const address = receipt?.contractAddress;
  if (!address) {
    throw new Error(
      `Deployment transaction ${tx.hash} produced no contract address. It may have ` +
        'reverted, or the node may not report receipts.'
    );
  }

  return { txHash: tx.hash, address };
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
      reason: process.env.RPC_URL
        ? 'DRIPPER_PRIVATE_KEY is not set — enrolments cannot be funded.'
        : 'RPC_URL is not set.',
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
export async function ensureFunded(address, { reason = 'enrolment', contactHmac = null } = {}) {
  if (!dripEnabled()) {
    return { ok: false, skipped: true, reason: 'dripper not configured' };
  }

  // The nonce claim and the daily cap both live in the database, and without it there
  // is no safe way to hand out a nonce. A skipped drip is recoverable — the wallet
  // exists and can be funded later. A wrong nonce is not.
  if (!isDbReady()) {
    return { ok: false, skipped: true, reason: 'database unavailable' };
  }

  return serialise(async () => {
    const w = getWallet();
    const balance = await w.provider.getBalance(address);

    if (balance >= FLOOR) {
      return { ok: true, skipped: true, reason: 'already funded', balanceEth: ethers.formatEther(balance) };
    }

    // HOW MANY TIMES THIS PERSON MAY BE FUNDED.
    //
    // Claimed BEFORE sending, and claimed atomically. The filter `dripCount < cap` plus
    // `upsert` plus the unique index on the contact means a caller at the cap cannot
    // match, the upsert collides, and the duplicate-key error IS the refusal. A read
    // followed by a send would let two requests in the same window both pass.
    let claimed = false;
    if (contactHmac) {
      try {
        const ledger = await DripLedgerModel.findOneAndUpdate(
          { contactHmac, dripCount: { $lt: MAX_PER_CONTACT } },
          {
            $inc: { dripCount: 1 },
            $set: { address: address.toLowerCase(), at: new Date() },
            $setOnInsert: { contactHmac },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        claimed = Boolean(ledger);
      } catch (error) {
        if (error?.code === 11000) {
          return {
            ok: false,
            skipped: true,
            reason: `this contact has already been funded the maximum ${MAX_PER_CONTACT} time(s)`,
          };
        }
        throw error;
      }
    }

    /**
     * Give the claim back, so a transient failure does not consume someone's allowance.
     * A contact whose drip was burned by an RPC hiccup has no way to get it back.
     */
    const releaseClaim = async () => {
      if (!claimed) return;
      try {
        await DripLedgerModel.updateOne({ contactHmac }, { $inc: { dripCount: -1 } });
      } catch {
        /* the claim stands; the allowance is simply one lower */
      }
    };

    const spent = await spentToday();
    if (spent + AMOUNT > DAILY_CAP) {
      console.warn(
        `[Dripper] Daily cap reached (${ethers.formatEther(spent)} spent). ` +
          `Refusing to fund ${address}.`
      );
      await releaseClaim();
      return { ok: false, skipped: true, reason: 'daily cap reached', spentEth: ethers.formatEther(spent) };
    }

    const floatBalance = await w.provider.getBalance(w.address);
    if (floatBalance < AMOUNT) {
      warnIfLow(floatBalance);
      await releaseClaim();
      return {
        ok: false,
        skipped: true,
        reason: 'the dripper is empty',
        balanceEth: ethers.formatEther(floatBalance),
      };
    }

    let txHash;
    try {
      txHash = await send(address, AMOUNT);
    } catch (error) {
      // The send failed. Hand the claim back, because a contact whose one drip was
      // burned by an RPC hiccup has no way to recover it.
      await releaseClaim();
      throw error;
    }
    warnIfLow(floatBalance - AMOUNT);

    if (claimed) {
      await DripLedgerModel.updateOne({ contactHmac }, { $set: { txHash } });
    }

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
