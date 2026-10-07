// THE DRIPPER.
//
// A small float of Sepolia ETH that lets a user act without ever thinking about
// gas. It exists because the alternative — making people acquire testnet ETH
// before they can grant consent — loses the user at the door.
//
// Three rules shape this file, each learned from a failure mode:
//
//   1. SENDS ARE SERIALISED ACROSS INSTANCES, AND THE EXACT SIGNED TRANSACTION IS
//      STORED BEFORE BROADCAST. If a node accepts a transaction but its reply is lost,
//      the next process can inspect or rebroadcast those same bytes without reusing the
//      nonce for a different payment.
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
import { randomUUID } from 'node:crypto';
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

const NONCE_STATE_VERSION = 2;
const NONCE_LEASE_MS = 90_000;
const NONCE_LEASE_HEARTBEAT_MS = 20_000;
const NONCE_LEASE_WAIT_MS = 120_000;

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

/** Create the counter once; old ambiguous counters are never rewound automatically. */
async function ensureNonceDocument(w, key) {
  let doc = await DripperModel.findOne({ address: key }).lean();
  if (!doc) {
    const pending = await w.provider.getTransactionCount(w.address, 'pending');
    try {
      await DripperModel.updateOne(
        { address: key },
        {
          $setOnInsert: {
            address: key,
            nextNonce: pending,
            nonceStateVersion: NONCE_STATE_VERSION,
            inFlight: 0,
            nonceLeaseId: '',
            nonceLeaseUntil: null,
            activeTransaction: null,
          },
        },
        { upsert: true }
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    doc = await DripperModel.findOne({ address: key }).lean();
  }
  if (!doc) throw new Error('Could not initialize the dripper nonce state.');
  if (Number(doc.nonceStateVersion || 0) >= NONCE_STATE_VERSION) return doc;

  const pending = await w.provider.getTransactionCount(w.address, 'pending');
  const oldNext = Number(doc.nextNonce || 0);
  if (Number(doc.inFlight || 0) > 0 || oldNext > pending) {
    throw new Error(
      'The saved dripper nonce predates durable transaction tracking and has an unresolved ' +
        'claim. Check the dripper account on chain before allowing another send; the counter ' +
        'was left unchanged.'
    );
  }

  const migrated = await DripperModel.updateOne(
    {
      address: key,
      nextNonce: oldNext,
      inFlight: { $in: [0, null] },
      $or: [{ nonceStateVersion: { $exists: false } }, { nonceStateVersion: { $lt: NONCE_STATE_VERSION } }],
    },
    {
      $set: {
        nextNonce: pending,
        nonceStateVersion: NONCE_STATE_VERSION,
        inFlight: 0,
        inFlightAt: null,
        nonceLeaseId: '',
        nonceLeaseUntil: null,
        activeTransaction: null,
      },
    }
  );
  doc = await DripperModel.findOne({ address: key }).lean();
  if (!migrated.matchedCount && Number(doc?.nonceStateVersion || 0) < NONCE_STATE_VERSION) {
    throw new Error('The dripper nonce state changed during migration. Retry after it settles.');
  }
  return doc;
}

/** A lease serializes the one hot wallet across every API instance. */
async function withNonceLease(task) {
  const w = getWallet();
  const key = w.address.toLowerCase();
  await ensureNonceDocument(w, key);

  const leaseId = randomUUID();
  const startedAt = Date.now();
  let locked = null;
  while (!locked) {
    const now = new Date();
    locked = await DripperModel.findOneAndUpdate(
      {
        address: key,
        $or: [{ nonceLeaseUntil: null }, { nonceLeaseUntil: { $lte: now } }],
      },
      { $set: { nonceLeaseId: leaseId, nonceLeaseUntil: new Date(now.getTime() + NONCE_LEASE_MS) } },
      { new: true }
    ).lean();
    if (locked) break;
    if (Date.now() - startedAt >= NONCE_LEASE_WAIT_MS) {
      throw new Error('Another dripper transaction is still active. Retry after it settles.');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  let heartbeatRunning = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      await DripperModel.updateOne(
        { address: key, nonceLeaseId: leaseId },
        { $set: { nonceLeaseUntil: new Date(Date.now() + NONCE_LEASE_MS) } }
      );
    } catch (error) {
      console.warn('[Dripper] Could not renew the nonce lease -', error.message);
    } finally {
      heartbeatRunning = false;
    }
  }, NONCE_LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await task({ w, key, leaseId });
  } finally {
    clearInterval(heartbeat);
    try {
      await DripperModel.updateOne(
        { address: key, nonceLeaseId: leaseId },
        { $set: { nonceLeaseId: '', nonceLeaseUntil: null } }
      );
    } catch (error) {
      console.warn('[Dripper] Could not release the nonce lease -', error.message);
    }
  }
}

async function assertNonceLease(key, leaseId) {
  const lease = await DripperModel.exists({
    address: key,
    nonceLeaseId: leaseId,
    nonceLeaseUntil: { $gt: new Date() },
  });
  if (!lease) throw new Error('The dripper nonce lease expired. Retry the transaction safely.');
}

async function storeTransactionError(key, leaseId, jobId, error) {
  try {
    await DripperModel.updateOne(
      { address: key, nonceLeaseId: leaseId, 'activeTransaction.id': jobId },
      {
        $set: {
          'activeTransaction.lastError': String(error?.shortMessage || error?.message || error),
          'activeTransaction.updatedAt': new Date(),
        },
      }
    );
  } catch {
    // The signed transaction remains in the shared document and can be retried later.
  }
}

async function persistSignedTransaction({ key, leaseId, job, rawTransaction, txHash }) {
  await assertNonceLease(key, leaseId);
  await DripperModel.updateOne(
    {
      address: key,
      nonceLeaseId: leaseId,
      'activeTransaction.id': job.id,
      'activeTransaction.rawTransaction': { $in: ['', null] },
    },
    {
      $set: {
        'activeTransaction.rawTransaction': rawTransaction,
        'activeTransaction.txHash': txHash,
        'activeTransaction.state': 'signed',
        'activeTransaction.lastError': '',
        'activeTransaction.updatedAt': new Date(),
      },
    }
  );

  const current = await DripperModel.findOne({ address: key }).lean();
  const active = current?.activeTransaction;
  if (!active || active.id !== job.id || !active.rawTransaction) {
    throw new Error('The signed dripper transaction was not saved; it was not broadcast.');
  }
  // If a lease owner signed it after a timeout, only those persisted bytes may be sent.
  return active;
}

async function finalizeTransaction({ w, key, leaseId, job, receipt }) {
  const success = Number(receipt?.status) === 1;
  const address =
    job.kind === 'deployment' && success
      ? receipt.contractAddress || ethers.getCreateAddress({ from: w.address, nonce: job.nonce })
      : '';
  const update = {
    $max: { nextNonce: job.nonce + 1 },
    $set: { activeTransaction: null },
  };
  if (job.kind === 'deployment' && success) {
    update.$push = {
      recentDeployments: {
        $each: [
          {
            fingerprint: job.fingerprint,
            txHash: job.txHash,
            address,
            chainId: String((await w.provider.getNetwork()).chainId),
            completedAt: new Date(),
          },
        ],
        $slice: -100,
      },
    };
  }

  const committed = await DripperModel.updateOne(
    {
      address: key,
      nonceLeaseId: leaseId,
      nonceLeaseUntil: { $gt: new Date() },
      'activeTransaction.id': job.id,
    },
    update
  );
  if (!committed.matchedCount) {
    const current = await DripperModel.findOne({ address: key }).lean();
    if (current?.activeTransaction?.id === job.id || Number(current?.nextNonce || 0) <= job.nonce) {
      throw new Error(`Transaction ${job.txHash} is confirmed, but its durable state needs a retry.`);
    }
  }

  return {
    success,
    nonce: job.nonce,
    kind: job.kind,
    fingerprint: job.fingerprint,
    txHash: job.txHash,
    address,
    error: success ? '' : `Transaction ${job.txHash} reverted on chain.`,
  };
}

async function processActiveTransaction({ w, key, leaseId, job }) {
  if (!job.rawTransaction) {
    await assertNonceLease(key, leaseId);
    const request =
      job.kind === 'deployment'
        ? { data: job.data, nonce: job.nonce }
        : { to: job.to, value: BigInt(job.value), nonce: job.nonce, gasLimit: 21_000n };
    const populated = await w.populateTransaction(request);
    const rawTransaction = await w.signTransaction(populated);
    const txHash = ethers.Transaction.from(rawTransaction).hash;
    job = await persistSignedTransaction({ key, leaseId, job, rawTransaction, txHash });
  }

  const txHash = job.txHash || ethers.Transaction.from(job.rawTransaction).hash;
  const trackedJob = { ...job, txHash };
  try {
    let receipt = null;
    try {
      receipt = await w.provider.getTransactionReceipt(txHash);
    } catch {
      // Rebroadcasting the persisted bytes remains safe when this read is unavailable.
    }
    if (receipt) return await finalizeTransaction({ w, key, leaseId, job: trackedJob, receipt });

    let transaction = null;
    try {
      transaction = await w.provider.getTransaction(txHash);
    } catch {
      // The exact signed bytes remain available if the node cannot answer this read.
    }
    if (!transaction) {
      try {
        transaction = await w.provider.broadcastTransaction(job.rawTransaction);
      } catch (error) {
        try {
          receipt = await w.provider.getTransactionReceipt(txHash);
        } catch {
          receipt = null;
        }
        if (receipt) return await finalizeTransaction({ w, key, leaseId, job: trackedJob, receipt });

        try {
          transaction = await w.provider.getTransaction(txHash);
        } catch {
          transaction = null;
        }
        if (!transaction) throw error;
      }
    }

    await assertNonceLease(key, leaseId);
    await DripperModel.updateOne(
      { address: key, nonceLeaseId: leaseId, 'activeTransaction.id': job.id },
      {
        $set: {
          'activeTransaction.state': 'broadcast',
          'activeTransaction.txHash': txHash,
          'activeTransaction.lastError': '',
          'activeTransaction.updatedAt': new Date(),
        },
      }
    );

    let mined;
    try {
      mined = await transaction.wait();
    } catch (error) {
      try {
        mined = await w.provider.getTransactionReceipt(txHash);
      } catch {
        mined = null;
      }
      if (!mined) throw error;
    }
    if (!mined) throw new Error(`Transaction ${txHash} has not produced a receipt yet.`);
    return await finalizeTransaction({ w, key, leaseId, job: trackedJob, receipt: mined });
  } catch (error) {
    await storeTransactionError(key, leaseId, job.id, error);
    throw error;
  }
}

async function runTransaction(intent) {
  return serialise(() =>
    withNonceLease(async ({ w, key, leaseId }) => {
      let state = await DripperModel.findOne({ address: key }).lean();
      if (state?.activeTransaction) {
        const previous = state.activeTransaction;
        const recovered = await processActiveTransaction({ w, key, leaseId, job: previous });
        const sameRequest = previous.kind === intent.kind && previous.fingerprint === intent.fingerprint;
        if (sameRequest) {
          if (!recovered.success) throw new Error(recovered.error);
          return recovered;
        }
        state = await DripperModel.findOne({ address: key }).lean();
      }

      const network = intent.kind === 'deployment' ? await w.provider.getNetwork() : null;
      if (network && state?.recentDeployments?.length) {
        const last = [...state.recentDeployments].reverse().find((deployment) =>
          deployment.fingerprint === intent.fingerprint && deployment.chainId === String(network.chainId)
        );
        if (last) {
          const code = await w.provider.getCode(last.address);
          if (code && code !== '0x') {
            return {
              success: true,
              kind: 'deployment',
              fingerprint: intent.fingerprint,
              txHash: last.txHash,
              address: last.address,
            };
          }
        }
      }

      await assertNonceLease(key, leaseId);
      const pending = await w.provider.getTransactionCount(w.address, 'pending');
      state = await DripperModel.findOne({ address: key }).lean();
      const currentNonce = Number(state?.nextNonce || 0);
      const nonce = Math.max(currentNonce, pending);
      if (pending > currentNonce) {
        await DripperModel.updateOne(
          { address: key, nonceLeaseId: leaseId, activeTransaction: null },
          { $max: { nextNonce: pending } }
        );
      }

      const now = new Date();
      const job = {
        id: randomUUID(),
        nonce,
        kind: intent.kind,
        to: intent.to || '',
        value: intent.value || '0',
        data: intent.data || '0x',
        fingerprint: intent.fingerprint,
        rawTransaction: '',
        txHash: '',
        state: 'reserved',
        lastError: '',
        createdAt: now,
        updatedAt: now,
      };
      const reserved = await DripperModel.findOneAndUpdate(
        {
          address: key,
          nonceLeaseId: leaseId,
          nonceLeaseUntil: { $gt: new Date() },
          activeTransaction: null,
        },
        { $set: { activeTransaction: job, nonceStateVersion: NONCE_STATE_VERSION } },
        { new: true }
      ).lean();
      if (!reserved?.activeTransaction) {
        throw new Error('Could not persist the dripper transaction intent before signing.');
      }

      const result = await processActiveTransaction({ w, key, leaseId, job: reserved.activeTransaction });
      if (!result.success) throw new Error(result.error);
      return result;
    })
  );
}

// Enrolment and top-up grants go to the account owner's EOA. The account contract is
// the identity used by ApnaRecord, but the owner pays gas for the outer execute call.
async function send(to, value) {
  const recipient = ethers.getAddress(to);
  const amount = BigInt(value);
  const fingerprint = ethers.keccak256(
    ethers.toUtf8Bytes(`transfer:${recipient.toLowerCase()}:${amount.toString()}`)
  );
  const result = await runTransaction({
    kind: 'transfer',
    to: recipient,
    value: amount.toString(),
    data: '0x',
    fingerprint,
  });
  return result.txHash;
}

/** Deploy once; a persisted signed transaction is rebroadcast byte-for-byte on retry. */
export async function deployContract(data) {
  if (!ethers.isHexString(data)) throw new Error('Deployment data must be hex-encoded.');
  const fingerprint = ethers.keccak256(data);
  const result = await runTransaction({ kind: 'deployment', data, fingerprint });
  if (!result.address) {
    throw new Error(
      `Deployment transaction ${result.txHash} produced no contract address. It may have ` +
        'reverted, or the node may not report receipts.'
    );
  }
  return { txHash: result.txHash, address: result.address };
}

const todayKey = () => new Date().toISOString().slice(0, 10);

/**
 * What this float has sent today.
 *
 * Counted, not summed. Every drip is exactly AMOUNT, so the total is a count times a
 * constant — and a count is something Mongo can increment atomically, which a wei total
 * is not, because wei does not fit in a JavaScript number.
 *
 * The version this replaces summed `drip.amount` over enrolment rows whose `drip.at`
 * was today. That field is SET on every drip rather than accumulated, so an address
 * funded three times contributed one amount and the cap was as loose as the repeat
 * count. Undercounting a cap is the direction that spends money.
 */
async function spentToday() {
  const key = getWallet().address.toLowerCase();
  const row = await DripperModel.findOne({ address: key }).lean();
  // A count from a previous day is not today's spend, and comparing the day here means
  // there is no scheduled reset job to forget to run.
  if (!row || row.spentDay !== todayKey()) return 0n;
  return BigInt(Number(row.spentCount || 0)) * AMOUNT;
}

/**
 * Record one send against today's allowance.
 *
 * Two writes, because the day has to roll: the first only matches when the stored day
 * is already today, the second resets it.
 *
 * A race between two instances on the first drip of a new day could reset twice and
 * undercount by one. Accepted, and named: avoiding it needs a transaction, and the
 * exposure is one drip on one day — against a cap that was previously looser than it
 * claimed by exactly the repeat count.
 */
async function noteSpendToday() {
  const key = getWallet().address.toLowerCase();
  const day = todayKey();
  try {
    const matched = await DripperModel.updateOne(
      { address: key, spentDay: day },
      { $inc: { spentCount: 1 } }
    );
    if (matched.matchedCount === 0) {
      await DripperModel.updateOne(
        { address: key },
        { $set: { spentDay: day, spentCount: 1 } },
        { upsert: true }
      );
    }
  } catch (error) {
    // Best effort. A lost count makes the cap looser, never tighter, and refusing to
    // drip because bookkeeping failed would be worse than the looser cap.
    console.warn('[Dripper] Could not record the daily spend -', error.message);
  }
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
 * an enrolment can still succeed when the drip is skipped — the account is created
 * either way, and an owner key without gas can be funded later.
 */
export async function ensureFunded(
  recipientAddress,
  { reason = 'enrolment', contactHmac = null, enrolmentAddress = recipientAddress } = {}
) {
  if (!dripEnabled()) {
    return { ok: false, skipped: true, reason: 'dripper not configured' };
  }

  if (!ethers.isAddress(recipientAddress) || !ethers.isAddress(enrolmentAddress)) {
    throw new Error('A valid recipient and enrolment address are required to fund a wallet.');
  }

  const recipient = ethers.getAddress(recipientAddress);
  const enrolment = ethers.getAddress(enrolmentAddress);

  // The nonce claim and the daily cap both live in the database, and without it there
  // is no safe way to hand out a nonce. A skipped drip is recoverable — the wallet
  // exists and can be funded later. A wrong nonce is not.
  if (!isDbReady()) {
    return { ok: false, skipped: true, reason: 'database unavailable' };
  }

  return serialise(async () => {
    const w = getWallet();
    const balance = await w.provider.getBalance(recipient);

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
            $set: { address: recipient.toLowerCase(), at: new Date() },
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
          `Refusing to fund ${recipient}.`
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
      txHash = await send(recipient, AMOUNT);
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
      await EnrolmentModel.updateOne({ address: enrolment.toLowerCase() }, { $inc: { 'drip.topUps': 1 } });
    }
    await EnrolmentModel.updateOne(
      { address: enrolment.toLowerCase() },
      { $set: { 'drip.amount': AMOUNT.toString(), 'drip.txHash': txHash, 'drip.at': new Date() } }
    );

    await noteSpendToday();

    console.log(`[Dripper] Sent ${ethers.formatEther(AMOUNT)} ETH to ${recipient} for ${enrolment} (${txHash})`);
    return { ok: true, skipped: false, txHash, amountEth: ethers.formatEther(AMOUNT) };
  });
}
