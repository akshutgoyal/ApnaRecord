// BINDING THE WALLET TO THE CONTACT, AND TO THE CHAIN.
//
// Three rules are under test here, and each of them was, until recently, absent:
//
//   1. ONE CONTACT, ONE WALLET. `address` was unique but `emailHmac` was not, so one
//      email could enrol unlimited wallets and take a 0.01 ETH drip with each. The
//      only ceiling was the global daily cap — a budget, not a control.
//
//   2. THE DRIP FOLLOWS THE PERSON, NOT THE ADDRESS. It is gated on the contact, so a
//      rebind to a fresh wallet cannot draw a second allowance.
//
//   3. A WALLET HOLDING RECORDS CANNOT BE REBOUND. Records are soulbound; moving the
//      binding would leave them owned by an address nobody can open.

import { ethers, Wallet } from 'ethers';
import { createWallet, sealPrivateKey, generateRecoveryCode } from '../../client/src/lib/keystore.js';
import { enrolMessage } from '../../client/src/lib/wireMessages.js';
import { check, group, report } from '../support/harness.mjs';

const API = process.env.API_URL || 'http://localhost:5000/api';
const CHAIN = process.env.CHAIN || 'http://127.0.0.1:8545';

async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const unique = () => `b${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reach into the stub chain to set how many records an address owns. */
async function setRecordCount(address, count) {
  const response = await fetch(CHAIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'mock_setRecordCount',
      params: [address, count],
    }),
  });
  return response.ok;
}

async function grantFor(email) {
  const requested = await post('/identity/email/request', { email });
  if (requested.status !== 200) throw new Error(`code request failed: ${requested.body.message}`);
  return post('/identity/email/verify', { email, code: requested.body.devCode });
}

/** Enrol a fresh wallet against a given email, returning everything needed later. */
async function enrolWith(email, token) {
  const grant = token ? { body: { token } } : await grantFor(email);
  const { address, privateKey } = createWallet();
  const recoveryCode = generateRecoveryCode();
  const sealed = await sealPrivateKey(privateKey, recoveryCode);
  const timestamp = Date.now();
  const signature = await new Wallet(privateKey).signMessage(enrolMessage(address, timestamp));

  const created = await post('/wallet/enrol', {
    address,
    sealed: sealed.sealed,
    salt: sealed.salt,
    iterations: sealed.iterations,
    grantToken: grant.body.token,
    timestamp,
    signature,
  });
  return { email, address, privateKey, recoveryCode, sealed, created };
}

group('one contact, one wallet');

const email = unique();
const first = await enrolWith(email);
check('the first wallet enrols', first.created.status === 201, JSON.stringify(first.created.body).slice(0, 160));
check('and is funded', Boolean(first.created.body.drip?.txHash), JSON.stringify(first.created.body.drip));

await sleep(2200);
const second = await enrolWith(email);
check(
  'a SECOND wallet against the same email is refused',
  second.created.status === 409 && second.created.body.error === 'ContactAlreadyBound',
  `${second.created.status} ${second.created.body.error}`
);
check(
  'and the refusal explains why, rather than saying "conflict"',
  /one contact, one wallet/i.test(second.created.body.message || ''),
  second.created.body.message
);

await sleep(2200);
const reEnrol = await enrolWith(email);
check(
  'a THIRD attempt is refused too, so the rule is not a one-shot',
  reEnrol.created.status === 409,
  `got ${reEnrol.created.status}`
);

group('the drip follows the person, not the address');

// The contact above has now been funded once. Its allowance is bounded by
// DRIP_MAX_PER_CONTACT, and a new wallet on the same contact cannot draw at all —
// which is the point, since a rebind would otherwise be a way to farm.

group('rebinding an empty wallet');

const rebindEmail = unique();
const rebindSource = await enrolWith(rebindEmail);
check('the wallet to be moved enrolled', rebindSource.created.status === 201, String(rebindSource.created.status));

await sleep(2200);
const grant = await grantFor(rebindEmail);

const replacement = createWallet();
const replacementCode = generateRecoveryCode();
const replacementSealed = await sealPrivateKey(replacement.privateKey, replacementCode);
const rebindTime = Date.now();
const rebindSignature = await new Wallet(replacement.privateKey).signMessage(
  enrolMessage(replacement.address, rebindTime)
);

const moved = await post('/wallet/rebind', {
  oldAddress: rebindSource.address,
  newAddress: replacement.address,
  sealed: replacementSealed.sealed,
  salt: replacementSealed.salt,
  iterations: replacementSealed.iterations,
  grantToken: grant.body.token,
  timestamp: rebindTime,
  signature: rebindSignature,
});
check('an empty wallet can be moved to a new key', moved.status === 200, `${moved.status} ${JSON.stringify(moved.body).slice(0, 160)}`);
check(
  'and the reply says no funds were issued, because the allowance was already drawn',
  /allowance|already drawn/i.test(moved.body.note || ''),
  moved.body.note
);

const oldLookup = await fetch(`${API}/wallet/${rebindSource.address}`);
check('the old address is no longer enrolled', oldLookup.status === 404, `got ${oldLookup.status}`);
const newLookup = await fetch(`${API}/wallet/${replacement.address}`);
check('the new address is enrolled', newLookup.status === 200, `got ${newLookup.status}`);

group('rebinding a wallet that holds records is refused');

// The guard the whole rule exists for. A soulbound record cannot follow the user to a
// new address, so moving the binding would leave it owned by an address nobody can
// open — still on-chain, permanently unreadable.
//
// The stub reports zero records for every address until told otherwise, so setting the
// count on the OLD address is what proves the guard reads the old wallet and not the
// new one. Without this, a guard that checked the wrong side would pass silently.
const heldAddress = replacement.address;
check('the stub accepted the record count', await setRecordCount(heldAddress, 1));

await sleep(2200);
const guardGrant = await grantFor(rebindEmail);
const doomed = createWallet();
const doomedSealed = await sealPrivateKey(doomed.privateKey, generateRecoveryCode());
const doomedTime = Date.now();
const doomedSignature = await new Wallet(doomed.privateKey).signMessage(
  enrolMessage(doomed.address, doomedTime)
);

const blocked = await post('/wallet/rebind', {
  oldAddress: heldAddress,
  newAddress: doomed.address,
  sealed: doomedSealed.sealed,
  salt: doomedSealed.salt,
  iterations: doomedSealed.iterations,
  grantToken: guardGrant.body.token,
  timestamp: doomedTime,
  signature: doomedSignature,
});
check(
  'a wallet holding records cannot be rebound',
  blocked.status === 409 && blocked.body.error === 'WalletHoldsRecords',
  `${blocked.status} ${blocked.body.error}`
);
check(
  'and the refusal names the reason: soulbound records would be stranded',
  /soulbound|unreadable/i.test(blocked.body.message || ''),
  blocked.body.message
);
check('and reports how many records are at stake', blocked.body.records === 1, String(blocked.body.records));

group('rebinding refuses what it cannot prove');

const noSignature = await post('/wallet/rebind', {
  oldAddress: replacement.address,
  newAddress: doomed.address,
  // Otherwise well-formed, so the request reaches the signature check rather than
  // stopping at shape validation — a refusal for the wrong reason proves nothing.
  sealed: replacementSealed.sealed,
  salt: replacementSealed.salt,
  iterations: replacementSealed.iterations,
  grantToken: 'whatever',
});
check('a rebind with no signature is refused', noSignature.status === 403, `got ${noSignature.status}`);

const sameAddress = await post('/wallet/rebind', {
  oldAddress: replacement.address,
  newAddress: replacement.address,
  sealed: replacementSealed.sealed,
  salt: replacementSealed.salt,
  grantToken: 'whatever',
  timestamp: Date.now(),
  signature: '0x',
});
check('a rebind to the same address is refused', sameAddress.status === 400, `got ${sameAddress.status}`);

group('the chain registration state is reported');

const lookup = await (await fetch(`${API}/wallet/${replacement.address}`)).json();
check(
  'a wallet lookup carries its on-chain registration state',
  lookup.onChain && typeof lookup.onChain.resolved === 'boolean',
  JSON.stringify(lookup.onChain)
);

report();
