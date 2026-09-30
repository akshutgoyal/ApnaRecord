// Wallet enrolment and lookup, end to end over HTTP.
//
// Run from the project root:  node tests/integration/wallet.test.mjs
// Requires the API pointed at the mock chain, with a funded dripper.

import fs from 'node:fs';
import { Wallet } from 'ethers';
import {
  createWallet,
  sealPrivateKey,
  generateRecoveryCode,
  openPrivateKey,
} from '../../client/src/lib/keystore.js';
import { enrolMessage } from '../../client/src/lib/wireMessages.js';
import { storeMessage } from '../../client/src/lib/wireMessages.js';
import { enrolMessage as serverEnrolMessage } from '../../server/src/controllers/walletController.js';
import { storeMessage as serverStoreMessage } from '../../server/src/controllers/recordController.js';
import { check, group, report } from '../support/harness.mjs';

const API = process.env.API_URL || 'http://localhost:5000/api';
const MOCK_LOG = process.env.MOCK_LOG || '/tmp/mock-chain.log';


async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const get = async (path) => (await fetch(`${API}${path}`)).json();

const unique = () => `w${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function verifyContact(email) {
  const requested = await post('/identity/email/request', { email });
  if (requested.status !== 200) throw new Error(`request failed: ${requested.body.message}`);
  return post('/identity/email/verify', { email, code: requested.body.devCode });
}

async function enrolOne() {
  const email = unique();
  const grant = await verifyContact(email);
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
  return { email, address, privateKey, recoveryCode, created };
}

/** Build an enrol body, letting the caller override individual fields. */
async function enrolBody(overrides = {}) {
  const { address, privateKey } = createWallet();
  const sealed = await sealPrivateKey(privateKey, generateRecoveryCode());
  const timestamp = Date.now();
  return {
    address,
    sealed: sealed.sealed,
    salt: sealed.salt,
    iterations: sealed.iterations,
    timestamp,
    signature: await new Wallet(privateKey).signMessage(enrolMessage(address, timestamp)),
    ...overrides,
  };
}

group('the wire format');
const probe = '0x0000000000000000000000000000000000000001';
check(
  'the client and server agree on the enrol message byte for byte',
  enrolMessage(probe, 1234567890) === serverEnrolMessage(probe, 1234567890),
  enrolMessage(probe, 1234567890)
);

// The store statement is the one that authenticates an upload, so drift here means
// every record upload is refused — and the failure presents as a permissions bug.
const probeDigest = `0x${'ab'.repeat(32)}`;
check(
  'the client and server agree on the store message byte for byte',
  storeMessage(7, probe, probeDigest, 1234567890) === serverStoreMessage(7, probe, probeDigest, 1234567890),
  storeMessage(7, probe, probeDigest, 1234567890)
);
check(
  'the store message lowercases the digest, so a checksum case cannot break it',
  storeMessage(7, probe, `0x${'AB'.repeat(32)}`, 1) === storeMessage(7, probe, `0x${'ab'.repeat(32)}`, 1)
);
check(
  'the store message binds the token id, the patient and the digest',
  storeMessage(7, probe, probeDigest, 1) !== storeMessage(8, probe, probeDigest, 1) &&
    storeMessage(7, probe, probeDigest, 1) !==
      storeMessage(7, '0x0000000000000000000000000000000000000002', probeDigest, 1) &&
    storeMessage(7, probe, probeDigest, 1) !== storeMessage(7, probe, `0x${'cd'.repeat(32)}`, 1)
);

group('enrolment');
const first = await enrolOne();
check('an enrolment with both proofs succeeds', first.created.status === 201, JSON.stringify(first.created.body).slice(0, 200));
check('a drip transaction comes back', Boolean(first.created.body.drip?.txHash), JSON.stringify(first.created.body.drip));
check('the address is echoed back masked', /^w•••@example\.com$/.test(first.created.body.emailMasked || ''), first.created.body.emailMasked);

group('what was actually stored');
const fetched = await get(`/wallet/${first.address}`);
const opened = await openPrivateKey(
  { sealed: fetched.enrolment.sealed, salt: fetched.enrolment.salt, iterations: fetched.enrolment.iterations },
  first.recoveryCode
);
check('the sealed blob opens with the recovery code', new Wallet(opened).address === first.address);
check('the blob does not contain the private key', !fetched.enrolment.sealed.includes(first.privateKey.slice(2)));
check('the identity comes back as a masked address', /^w•••@example\.com$/.test(fetched.enrolment.emailMasked || ''), fetched.enrolment.emailMasked);
check('the raw address is not stored, only the mask', !JSON.stringify(fetched.enrolment).includes(first.email));

group('what enrolment refuses');
const badSig = await post(
  '/wallet/enrol',
  await enrolBody({
    // Signed for a different address than the one being bound.
    signature: await (async () => {
      const decoy = createWallet();
      return new Wallet(decoy.privateKey).signMessage(enrolMessage('0x0000000000000000000000000000000000000009', Date.now()));
    })(),
    grantToken: 'anything',
  })
);
check('a signature for a different address is refused', badSig.status === 403, `got ${badSig.status}`);

const grantOnce = await verifyContact(unique());
const body = await enrolBody({ grantToken: grantOnce.body.token });
const accepted = await post('/wallet/enrol', body);
check('a valid signature plus a live grant is accepted', accepted.status === 201, JSON.stringify(accepted.body).slice(0, 160));

// The SAME body, unchanged. Re-stamping the timestamp would invalidate the signature and
// the key check would fire first — passing for the wrong reason.
const replay = await post('/wallet/enrol', body);
check(
  'the SAME grant cannot be spent twice',
  replay.status === 403 && replay.body.error === 'ContactVerificationExpired',
  `${replay.status} ${replay.body.error}`
);

const noGrant = await post('/wallet/enrol', await enrolBody());
check(
  'a valid key signature with no grant fails at the CONTACT check, not the key check',
  noGrant.status === 403 && noGrant.body.error === 'ContactVerificationRequired',
  `${noGrant.status} ${noGrant.body.error}`
);

group('finding a wallet by address');
const found = await get(`/wallet/${first.address}`);
check('a wallet is found by its address', found.enrolment?.address === first.address.toLowerCase());

await sleep(2200);
const stranger = await verifyContact(unique());
const strangers = await post('/wallet/lookup', { grantToken: stranger.body.token });
check(
  'a verified address with no wallet gets an empty list, not someone else s',
  (strangers.body.wallets || []).length === 0,
  JSON.stringify(strangers.body.wallets)
);

group('concurrent enrolments');
const burst = await Promise.all([enrolOne(), enrolOne(), enrolOne(), enrolOne()]);
check('all four were created', burst.every((item) => item.created.status === 201), burst.map((b) => b.created.status).join(','));

const nonceLog = fs.existsSync(MOCK_LOG) ? fs.readFileSync(MOCK_LOG, 'utf8') : '';
check(
  'the mock chain saw no nonce collision',
  !nonceLog.includes('NONCE COLLISION'),
  nonceLog.split('\n').filter((line) => line.includes('COLLISION')).join(' | ')
);

const dripper = await get('/dripper');
check('the dripper is enabled and reports a balance', dripper.enabled === true, JSON.stringify(dripper).slice(0, 160));

report();
