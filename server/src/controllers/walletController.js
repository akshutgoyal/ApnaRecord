// WALLET ENROLMENT.
//
// Creates the account a user never knows they have. The client generates the key
// and locks it behind a recovery code; this server stores the locked blob and
// nothing else. There is no endpoint here that can sign, decrypt, or act as a user,
// and there must never be one — the moment such an endpoint exists, the hospital
// can consent on a patient's behalf and the product's central claim becomes false.
//
// A NOTE ON THE BLOB FETCH. `GET /api/wallet/:address` is public, and was very
// nearly gated behind the contact grant. It was left public deliberately — the
// ciphertext is useless without a 100-bit recovery code, whereas a patient who
// changed their email address would have lost access to soulbound records for ever. The
// reasoning is recorded on getWallet below, because the decision is a trade and not
// an oversight. `POST /api/wallet/lookup` is the recommended path.

import { ethers } from 'ethers';
import { EnrolmentModel, isDbReady } from '../models/index.js';
import { ensureFunded, dripperStatus } from '../services/dripper.js';
import { consumeGrant } from '../services/otp.js';
import { noteHit } from '../lib/rateLimit.js';
import {
  claimOneUseNonce,
  signedWriteDomain,
  verifyDeadlineMessage,
} from '../lib/signature.js';
import { call, getAddress as contractAddress } from '../services/chain.js';
import { deployAccount } from '../services/account.js';

/**
 * Whether the chain knows this address as a registered identity.
 *
 * A wallet can be created and funded here long before an administrator registers it,
 * and until it is registered the contract will refuse to mint it a record. The UI has
 * always said so in prose; this makes it a fact the page can check rather than a
 * sentence it hopes is true.
 *
 * Never throws. The chain being unreachable must not fail an enrolment — it should
 * only stop us claiming the wallet is registered, which is what `registered: null`
 * means.
 */
async function onChainIdentity(address) {
  try {
    const [identity] = await call('identities', [address]);
    return { resolved: true, registered: Boolean(identity?.[2]), label: identity?.[0] || '' };
  } catch (error) {
    return {
      resolved: false,
      registered: null,
      reason: error?.shortMessage || error?.message || 'the chain could not be read',
    };
  }
}

const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_SEALED_CHARS = 512;
const MAX_SALT_CHARS = 64;

/**
 * A limiter on the blob fetch.
 *
 * Not a security boundary — the blob is ciphertext and its confidentiality rests
 * entirely on the recovery code. This is here so the endpoint cannot be used to
 * enumerate which addresses are enrolled at volume, which is a privacy question
 * rather than a cryptographic one.
 */
const LOOKUP_WINDOW_MS = 60 * 1000;
const LOOKUP_MAX = 20;

/** Kept in one place so client and server cannot drift apart. */
export function enrolMessage(address, timestamp) {
  return (
    'ApnaRecord create wallet\n' +
    `address: ${ethers.getAddress(address)}\n` +
    `timestamp: ${timestamp}`
  );
}

export function dripMessage(address, timestamp) {
  return (
    'ApnaRecord request test funds\n' +
    `address: ${ethers.getAddress(address)}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * The statement a key signs to replace the wrapping on its own enrolment.
 *
 * Signed by the account's OWN key, not by a contact grant. Rotation re-wraps the key
 * that owns the account, so the only thing that can prove the caller holds it is a
 * signature from it — an email grant would prove something else entirely, and would
 * let anyone who controls the mailbox rewrite the wrapping on a key they do not have.
 */
export function recoveryPayloadHash({ sealed, salt, iterations }) {
  const values = [String(sealed), String(salt), Number(iterations)];
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(values)));
}

export function rotateRecoveryMessage(address, dataHash, deadline, nonce, domain = signedWriteDomain()) {
  return (
    'ApnaRecord rotate recovery code\n' +
    `chainId: ${domain.chainId}\n` +
    `verifyingContract: ${domain.verifyingContract}\n` +
    `address: ${ethers.getAddress(address)}\n` +
    `payloadHash: ${String(dataHash).toLowerCase()}\n` +
    `deadline: ${deadline}\n` +
    `nonce: ${String(nonce).toLowerCase()}`
  );
}

/** Recover the signer and require it to be the address in question. */
function verify(message, address, timestamp, signature) {
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_AGE_MS) {
    return 'The signature is stale. Refresh the page and try again.';
  }
  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    return 'That signature could not be read.';
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return `That signature was made by ${recovered}, not by ${address}.`;
  }
  return null;
}

function requireDb(res) {
  if (!isDbReady()) {
    res.status(503).json({
      error: 'DatabaseUnavailable',
      message:
        'Wallets are stored sealed in the database, so enrolment and unlock need it. ' +
        'Everything already on-chain — ownership, consent, verification — still works without it.',
    });
    return true;
  }
  return false;
}

function looksLikeBase64(value, maxChars) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars && /^[A-Za-z0-9+/]+=*$/.test(value);
}

/**
 * POST /api/wallet/enrol
 * Body: { address, sealed, salt, iterations, timestamp, signature, grantToken }
 *
 * The signature proves the caller holds the key being enrolled, so nobody can
 * pre-register an address they do not control and squat on someone else's futures.
 *
 * The grant proves the caller controls the email address being bound. Both are
 * required, and they prove different things: that you hold this key, and that this
 * address is yours. An address alone would let anyone bind someone else's
 * wallet to their own email address and then look it up later.
 */
export async function enrol(req, res) {
  if (requireDb(res)) return;

  const { address, sealed, salt, iterations, timestamp, signature, grantToken } = req.body || {};

  // Validated against a fixed set rather than stored as given: it is displayed to an
  // administrator, and an unvalidated string that reaches a UI is a small attack surface
  // for no benefit. An unknown value is dropped rather than rejected -- a bad role should
  // not cost someone their account, and it grants nothing either way.
  const REQUESTABLE = ['patient', 'doctor', 'auditor', 'hospital'];
  const requestedRole = REQUESTABLE.includes(String(req.body?.requestedRole || '').toLowerCase())
    ? String(req.body.requestedRole).toLowerCase()
    : '';

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  if (!looksLikeBase64(sealed, MAX_SEALED_CHARS)) {
    return res.status(400).json({ error: 'BadRequest', message: 'sealed must be base64 ciphertext.' });
  }
  if (!looksLikeBase64(salt, MAX_SALT_CHARS)) {
    return res.status(400).json({ error: 'BadRequest', message: 'salt must be base64.' });
  }
  if (!timestamp || !signature) {
    return res.status(400).json({
      error: 'SignatureRequired',
      message: 'A signed statement from the new wallet is required.',
    });
  }

  const problem = verify(enrolMessage(address, timestamp), address, timestamp, signature);
  if (problem) return res.status(403).json({ error: 'SignatureInvalid', message: problem });

  // Spend the contact grant. This is what makes the address on the record a verified
  // address rather than a claim.
  let grant;
  try {
    grant = await consumeGrant(grantToken);
  } catch (error) {
    return res.status(403).json({
      error: error.code || 'ContactVerificationRequired',
      message: error.message,
    });
  }

  try {
    // A repeat enrolment with the SAME KEY returns the same account rather than
    // deploying a second one.
    //
    // Looked up by owner rather than by account address, because the account does not
    // exist until it has been deployed — and by the time we could check its address, a
    // duplicate would already have been created. A user who refreshed mid-flow, or
    // simply enrolled twice, would otherwise end up with two accounts and no way to
    // tell which one held their records.
    const existing = await EnrolmentModel.findOne({ owner: address.toLowerCase() }).lean();

    if (existing) {
      if (existing.sealed !== sealed) {
        return res.status(409).json({
          error: 'AlreadyEnrolled',
          message:
            'This key already has an account, and the sealed blob on file differs from the one ' +
            'you sent, so nothing was changed. If you have lost your recovery code, the record ' +
            'is soulbound and the key cannot be replaced.',
        });
      }
      return res.status(200).json({
        ok: true,
        existing: true,
        address: existing.address,
        owner: existing.owner,
        emailMasked: existing.identity?.emailMasked || '',
        createdAt: existing.createdAt,
        onChain: await onChainIdentity(existing.address),
        note:
          'This key already has an account. Nothing was deployed, and nothing was funded twice.',
      });
    }

    // ONE EMAIL, ONE ACCOUNT.
    //
    // Looked up here so the refusal can explain itself, and enforced again by a unique
    // index because two simultaneous enrolments would both pass this lookup. Without
    // it, one email could enrol unlimited accounts and take a 0.01 ETH drip with each —
    // the global daily cap bounds the spend but does not make it cost anything.
    const holder = await EnrolmentModel.findOne({
      'identity.emailHmac': grant.contactHmac,
    }).lean();

    if (holder && holder.owner !== address.toLowerCase()) {
      return res.status(409).json({
        error: 'ContactAlreadyBound',
        message:
          'That email address is already bound to a different account. One contact, one ' +
          'account — otherwise every new wallet with the same address would take another drip ' +
          'of test funds. If the bound account is lost, its recovery code is the path, because ' +
          'a soulbound record cannot follow you to a new address.',
        boundTo: holder.identity?.emailMasked || undefined,
      });
    }

    // DEPLOY THE ACCOUNT.
    //
    // This is what owns the records, for ever, and it exists so that the key signing for
    // it can do nothing except call ApnaRecord through it — a plain EOA key could sign
    // any transaction, any message, on any chain.
    //
    // The server pays, because an account cannot fund its own creation. It cannot
    // quietly substitute its own key either: the client reads `owner()` back and
    // refuses unless it is the key it just used.
    let account;
    try {
      account = await deployAccount({
        owner: address,
        allowedTargets: [contractAddress()],
      });
    } catch (error) {
      return res.status(502).json({
        error: 'AccountDeployFailed',
        message:
          'Your key is fine, but the account that owns records could not be created, so ' +
          `nothing was enrolled: ${error?.shortMessage || error.message}`,
      });
    }

    let enrolment;
    try {
      enrolment = await EnrolmentModel.create({
        requestedRole,
        address: account.address.toLowerCase(),
        owner: address.toLowerCase(),
        sealed,
        salt,
        iterations: Number(iterations) || 600000,
        identity: {
          kind: 'email',
          emailHmac: grant.contactHmac,
          // Taken from the grant, which the server derived. A client cannot put
          // arbitrary text next to a verified email address.
          emailMasked: grant.contactMasked,
          verifiedAt: new Date(),
        },
        account: { txHash: account.txHash, deployedAt: new Date() },
      });
    } catch (error) {
      // The unique indexes rejecting a race the lookups above could not see.
      if (error?.code === 11000) {
        return res.status(409).json({
          error: 'ContactAlreadyBound',
          message:
            'That key or email was bound to another account at the same moment as this ' +
            'enrolment. Nothing was changed — try again with the account you already have.',
        });
      }
      throw error;
    }

    // The owner key submits account.execute and pays for that outer transaction. The
    // account contract is msg.sender only for the inner ApnaRecord call, so funding it
    // does not pay for the owner's transaction.
    //
    // Keep the enrolment address for bookkeeping; send funds to the owner EOA. The
    // contact limit follows the person through a rebind.
    let drip;
    try {
      drip = await ensureFunded(enrolment.owner, {
        enrolmentAddress: enrolment.address,
        contactHmac: grant.contactHmac,
      });
    } catch (error) {
      // The account exists and the blob is stored. Failing the whole enrolment because
      // the float hiccuped would lose an account we can still fund later.
      console.warn(
        `[Wallet] Enrolled ${enrolment.address} but the owner-key drip failed: ${error.message}`
      );
      drip = { ok: false, skipped: true, reason: error.message };
    }

    return res.status(201).json({
      ok: true,
      // The account. This is the identity the client keeps and the address records will
      // be minted to — not the signing key, which never appears on-chain as an owner.
      address: enrolment.address,
      owner: enrolment.owner,
      accountTxHash: account.txHash,
      emailMasked: enrolment.identity.emailMasked,
      createdAt: enrolment.createdAt,
      drip,
      onChain: await onChainIdentity(enrolment.address),
      note:
        'The account owns your records and its owner can never change. The server holds a ' +
        'sealed blob it cannot open — your recovery code is the only thing that can, which ' +
        'is why losing it loses the account.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'EnrolFailed', message: error.message });
  }
}

/**
 * POST /api/wallet/lookup  { grantToken }
 *
 * Find the wallets bound to an email address the caller has just proved they control.
 *
 * This replaces looking a wallet up by typing its address, which was the weakest
 * point in the design: an address is public, so anyone could name one and receive a
 * ciphertext to attack offline. Now the lookup requires a verified address.
 *
 * It still returns ciphertext, and only ciphertext. Knowing which address belongs
 * to which address is a real leak on its own, which is precisely why it is
 * gated.
 */
export async function lookupWallets(req, res) {
  if (requireDb(res)) return;

  let grant;
  try {
    grant = await consumeGrant(req.body?.grantToken);
  } catch (error) {
    return res.status(401).json({ error: error.code || 'ContactVerificationRequired', message: error.message });
  }

  try {
    const rows = await EnrolmentModel.find({ 'identity.emailHmac': grant.contactHmac }).lean();
    return res.json({
      wallets: rows.map((row) => ({
        address: row.address,
        sealed: row.sealed,
        salt: row.salt,
        iterations: row.iterations,
        emailMasked: row.identity?.emailMasked || '',
        createdAt: row.createdAt,
      })),
      note:
        'Ciphertext. Useless without the recovery code, which the server has never seen. ' +
        'Verifying an email address can locate a wallet; it can never open one.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'WalletReadFailed', message: error.message });
  }
}

/**
 * GET /api/wallet/:address
 *
 * The sealed blob, so a new device can open a wallet it has never seen.
 *
 * WHY THIS IS NOT GATED, having first been gated. The obvious move is to require a
 * verified email address before handing over a blob, and that is what this did for
 * an afternoon. It was reverted deliberately, because the trade is bad:
 *
 *   What gating buys: an attacker who knows an address can no longer collect a
 *   ciphertext to attack offline. But the ciphertext is AES-GCM over a key derived
 *   from a 100-bit recovery code at 600,000 PBKDF2 iterations. Harvesting it is not
 *   a step towards anything — the offline attack is already infeasible by a margin
 *   of about 2^100.
 *
 *   What gating costs: a patient who changes their email address can no longer find
 *   their wallet at all. And because the records are soulbound with no transfer and
 *   no recovery, that is not an inconvenience — it is losing their medical history
 *   permanently.
 *
 * So the far smaller risk is the one to take. The fetch is rate-limited instead, and
 * the email path is the one the app recommends because it is better for the user
 * rather than because the address path is unsafe.
 *
 * If the email address is ever treated as a required locator, this decision has to be
 * revisited together with recovery — the two are the same problem.
 */
export async function getWallet(req, res) {
  if (requireDb(res)) return;
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }

  if (!(await noteHit('wallet-lookup-ip', req.ip, LOOKUP_MAX, LOOKUP_WINDOW_MS))) {
    return res.status(429).json({
      error: 'TooManyRequests',
      message: 'Too many wallet lookups from this address. Try again shortly.',
    });
  }

  try {
    const enrolment = await EnrolmentModel.findOne({ address: address.toLowerCase() }).lean();
    if (!enrolment) {
      return res.status(404).json({
        error: 'NotEnrolled',
        message: 'No wallet has been created for that address.',
      });
    }

    return res.json({
      enrolment: {
        address: enrolment.address,
        sealed: enrolment.sealed,
        salt: enrolment.salt,
        iterations: enrolment.iterations,
        emailMasked: enrolment.identity?.emailMasked || '',
        createdAt: enrolment.createdAt,
      },
      onChain: await onChainIdentity(address),
      note: 'Ciphertext. Useless without the recovery code, which the server has never seen.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'WalletReadFailed', message: error.message });
  }
}

/**
 * POST /api/wallet/:address/rotate-recovery
 * Body: { sealed, salt, iterations, deadline, nonce, signature }
 *
 * Replaces the wrapping on an enrolment. The key does not change, the account does not
 * change, and nothing on chain moves — only the code that opens the local copy is
 * replaced, so the previous code stops working the moment this succeeds.
 *
 * WHAT THIS DOES AND DOES NOT BUY YOU, because the difference is the whole point:
 *
 *   It DOES help when a recovery code leaked somewhere it should not have been — a
 *   photo, a shared note, a screenshot. From here on that code opens nothing.
 *
 *   It does NOT help if whoever holds the old code already fetched the old blob. Code
 *   plus blob IS the private key, and the key is the account's immutable owner, so
 *   nothing off-chain can take it back. Rotation bounds future exposure; it cannot
 *   undo past exposure. Saying so plainly is better than implying a guarantee.
 */
export async function rotateRecovery(req, res) {
  if (requireDb(res)) return;

  const { address } = req.params;
  const { sealed, salt, iterations, deadline, nonce, signature } = req.body || {};

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  if (!looksLikeBase64(sealed, MAX_SEALED_CHARS) || !looksLikeBase64(salt, MAX_SALT_CHARS)) {
    return res.status(400).json({ error: 'BadRequest', message: 'sealed and salt must be base64.' });
  }

  // The KDF parameters are part of what is being stored, so they are bounded here
  // rather than taken on trust. A caller who could set `iterations` to 1 would be
  // choosing how hard their own key is to brute-force — and, if they later forgot the
  // code, would have avoided the cost that exists to prevent exactly that.
  const rounds = Number(iterations) || 600000;
  if (!Number.isInteger(rounds) || rounds < 100000 || rounds > 10000000) {
    return res.status(400).json({
      error: 'BadRequest',
      message: 'iterations must be an integer between 100000 and 10000000.',
    });
  }

  try {
    // `:address` is the DEPLOYED ACCOUNT — that is what the enrolment row is keyed by,
    // and what a lookup names. The sealed copy belongs to its `owner`, the key.
    const existing = await EnrolmentModel.findOne({ address: address.toLowerCase() }).lean();
    if (!existing) {
      return res.status(404).json({
        error: 'NotEnrolled',
        message: 'No wallet has been created for that address.',
      });
    }

    // The signature must come from the OWNER key, not from `address`. The account is a
    // contract and cannot sign at all, so requiring a signature that recovers to it
    // would not be stricter — it would make rotation impossible.
    const authorization = await verifyDeadlineMessage({
      message: rotateRecoveryMessage(
        address,
        recoveryPayloadHash({ sealed, salt, iterations: rounds }),
        deadline,
        nonce
      ),
      address: existing.owner,
      deadline,
      nonce,
      signature,
    });
    if (authorization.error) {
      return res.status(403).json({ error: 'SignatureInvalid', message: authorization.error });
    }

    const claim = await claimOneUseNonce({
      bucket: 'signed-write',
      address: existing.owner,
      deadline,
      nonce,
    });
    if (claim) return res.status(claim.status).json({ error: claim.code, message: claim.error });

    await EnrolmentModel.updateOne(
      { address: address.toLowerCase() },
      { $set: { sealed, salt, iterations: rounds, rotatedAt: new Date() } }
    );

    return res.json({
      ok: true,
      address: existing.address,
      note: 'Recovery code replaced. The previous code no longer opens this wallet.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'RotateFailed', message: error.message });
  }
}

/**
 * POST /api/wallet/:address/drip
 * Body: { timestamp, signature }
 *
 * Signed, so this cannot be used as an open faucet by anyone who happens to know an
 * enrolled address.
 *
 * It draws on the SAME per-contact allowance as enrolment. Gating only on the floor
 * ("does this wallet have enough?") would be farmable — create a wallet, take a drip,
 * rebind to a fresh address with a zero balance, take another — because a balance is a
 * fact about a wallet and the float is meant to be spent per person.
 */
export async function requestDrip(req, res) {
  if (requireDb(res)) return;
  const { address } = req.params;
  const { timestamp, signature } = req.body || {};

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }

  try {
    const enrolment = await EnrolmentModel.findOne({ address: address.toLowerCase() }).lean();
    if (!enrolment) {
      return res.status(404).json({ error: 'NotEnrolled', message: 'That wallet is not enrolled.' });
    }

    // `:address` is the DEPLOYED ACCOUNT — the enrolment is keyed by it — and the
    // signature comes from its `owner`, the key. The account is a contract and cannot
    // sign, so verifying against `address` refused every genuine request. That made the
    // automatic top-up silently dead, and it failed in the worst way available: the
    // client reports "the float did not send", which reads like an empty dripper rather
    // than a signature check that could never pass. Same rule as `rotateRecovery`.
    const problem = verify(dripMessage(address, timestamp), enrolment.owner, timestamp, signature);
    if (problem) return res.status(403).json({ error: 'SignatureInvalid', message: problem });

    const result = await ensureFunded(enrolment.owner, {
      reason: 'top-up',
      enrolmentAddress: enrolment.address,
      contactHmac: enrolment.identity?.emailHmac || null,
    });
    return res.json({ ok: result.ok, ...result });
  } catch (error) {
    return res.status(502).json({ error: 'DripFailed', message: error.message });
  }
}

/**
 * POST /api/wallet/rebind
 *
 * Move a wallet onto a new key BEFORE it holds anything.
 *
 * This is not recovery. Recovery is for a wallet that already owns records, and it has
 * to happen inside an account, because a soulbound record cannot be moved to a new
 * address. This covers the ordinary case: an account created by mistake, or a device
 * lost while the wallet is still empty.
 *
 * Body: { oldAddress, newAddress, sealed, salt, iterations, timestamp, signature, grantToken }
 */
export async function rebind(req, res) {
  if (requireDb(res)) return;

  const {
    oldAddress,
    newAddress,
    sealed,
    salt,
    iterations,
    timestamp,
    signature,
    grantToken,
  } = req.body || {};

  if (!ethers.isAddress(oldAddress) || !ethers.isAddress(newAddress)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Both addresses must be valid.' });
  }
  if (oldAddress.toLowerCase() === newAddress.toLowerCase()) {
    return res.status(400).json({ error: 'BadRequest', message: 'Those are the same address.' });
  }
  if (!looksLikeBase64(sealed, MAX_SEALED_CHARS) || !looksLikeBase64(salt, MAX_SALT_CHARS)) {
    return res.status(400).json({ error: 'BadRequest', message: 'sealed and salt must be base64.' });
  }

  // The new key signs for itself — otherwise anyone could point a wallet at a key they
  // do not hold and lock the real owner out of their own enrolment record.
  const problem = verify(enrolMessage(newAddress, timestamp), newAddress, timestamp, signature);
  if (problem) return res.status(403).json({ error: 'SignatureInvalid', message: problem });

  // And the caller still controls the contact the wallet is bound to.
  let grant;
  try {
    grant = await consumeGrant(grantToken);
  } catch (error) {
    return res.status(403).json({
      error: error.code || 'ContactVerificationRequired',
      message: error.message,
    });
  }

  try {
    const existing = await EnrolmentModel.findOne({ address: oldAddress.toLowerCase() }).lean();
    if (!existing) {
      return res.status(404).json({
        error: 'NotEnrolled',
        message: 'No wallet has been created for that address.',
      });
    }
    if (existing.identity?.emailHmac !== grant.contactHmac) {
      return res.status(403).json({
        error: 'ContactMismatch',
        message: 'That verified address is not the one bound to this wallet.',
      });
    }

    // THE GUARD.
    //
    // Records are soulbound: they are owned by one account for ever and the contract
    // refuses to move them. So an account that holds one cannot be abandoned — the
    // record would still exist, still owned by the old account, and nobody could ever
    // read it again. Refusing is the honest answer; silently orphaning it is not.
    let held;
    try {
      const [balance] = await call('balanceOf', [oldAddress]);
      held = Number(balance);
    } catch (error) {
      return res.status(502).json({
        error: 'ChainUnavailable',
        message:
          'Could not confirm the old account is empty, so nothing was moved. Retry when the ' +
          `chain is reachable: ${error?.shortMessage || error.message}`,
      });
    }

    if (held > 0) {
      return res.status(409).json({
        error: 'WalletHoldsRecords',
        message:
          `That account holds ${held} record(s). Records are soulbound, so they cannot follow ` +
          'you to a new account, and moving the binding would leave them permanently ' +
          'unreadable. Recovery is the path for an account in that state.',
        records: held,
      });
    }

    // A NEW ACCOUNT, not a moved one.
    //
    // The account's owner is immutable — that is what makes the address permanent — so
    // a rebind cannot re-point the existing account at a new key. It creates a fresh
    // account for the new key, and the old one is simply left behind, empty.
    let account;
    try {
      account = await deployAccount({
        owner: newAddress,
        allowedTargets: [contractAddress()],
      });
    } catch (error) {
      return res.status(502).json({
        error: 'AccountDeployFailed',
        message: `The new account could not be created, so nothing was moved: ${error?.shortMessage || error.message}`,
      });
    }

    try {
      await EnrolmentModel.updateOne(
        { address: oldAddress.toLowerCase() },
        {
          $set: {
            address: account.address.toLowerCase(),
            owner: newAddress.toLowerCase(),
            sealed,
            salt,
            iterations: Number(iterations) || 600000,
            'identity.verifiedAt': new Date(),
            account: { txHash: account.txHash, deployedAt: new Date() },
          },
        }
      );
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({
          error: 'AlreadyEnrolled',
          message: 'That new key already has an account.',
        });
      }
      throw error;
    }

    return res.json({
      ok: true,
      from: oldAddress.toLowerCase(),
      to: account.address.toLowerCase(),
      owner: newAddress.toLowerCase(),
      accountTxHash: account.txHash,
      onChain: await onChainIdentity(account.address),
      note:
        'A new account was created for the new key, because an account owner can never change. ' +
        'No test funds are issued: this contact has already drawn its allowance, and paying ' +
        'again on every rebind is exactly how the float would be farmed.',
    });
  } catch (error) {
    return res.status(500).json({ error: 'RebindFailed', message: error.message });
  }
}

/** GET /api/dripper — the float's health. Preflight a demo with this. */
export async function dripperHealth(req, res) {
  try {
    return res.json(await dripperStatus());
  } catch (error) {
    return res.status(502).json({ error: 'DripperUnavailable', message: error.message });
  }
}
