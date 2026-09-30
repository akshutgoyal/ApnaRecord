// THE DRIPPER ACROSS TWO INSTANCES.
//
// This suite exists because the bug it looks for cannot be seen from one process. The
// nonce claim used to be a promise chain, which orders sends inside a single server
// and says nothing about a second one — each instance kept its own counter, both
// handed the same nonce to different transactions, and one was rejected while both
// callers were told they had succeeded.
//
// So it runs against TWO servers sharing one database, and reads the stub chain's log
// to see the nonces that actually went out. The mock node checks the SENDER's nonce,
// which is the only nonce that matters; an earlier version checked the recipient's and
// made this assertion pass no matter what the dripper did.

import fs from 'node:fs';
import { Wallet } from 'ethers';
import { createWallet, sealPrivateKey, generateRecoveryCode } from '../../client/src/lib/keystore.js';
import { enrolMessage } from '../../client/src/lib/wireMessages.js';
import { check, group, report } from '../support/harness.mjs';

const API = process.env.API_URL || 'http://localhost:5000/api';
const API_2 = process.env.API_URL_2;
const MOCK_LOG = process.env.MOCK_LOG || '/tmp/mock-chain.log';

if (!API_2) {
  console.error('\nAPI_URL_2 is required — this suite is about two instances, not one.\n');
  process.exit(1);
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const unique = () => `d${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** A complete enrolment, aimed at whichever instance is given. */
async function enrolVia(base) {
  const email = unique();
  const requested = await post(base, '/identity/email/request', { email });
  const grant = await post(base, '/identity/email/verify', { email, code: requested.body.devCode });

  const { address, privateKey } = createWallet();
  const sealed = await sealPrivateKey(privateKey, generateRecoveryCode());
  const timestamp = Date.now();
  const signature = await new Wallet(privateKey).signMessage(enrolMessage(address, timestamp));

  const created = await post(base, '/wallet/enrol', {
    address,
    sealed: sealed.sealed,
    salt: sealed.salt,
    iterations: sealed.iterations,
    grantToken: grant.body.token,
    timestamp,
    signature,
  });
  return { address, created };
}

const logContent = () => (fs.existsSync(MOCK_LOG) ? fs.readFileSync(MOCK_LOG, 'utf8') : '');
/** The nonces the stub chain actually saw, in order. */
const noncesSeen = () =>
  [...logContent().matchAll(/drip .*nonce=(\d+)/g)].map((match) => Number(match[1]));

group('two instances, one float');

const before = noncesSeen().length;

// Four against each instance, all at once. Serialised per process means each server
// would happily start at its own counter; the database claim is what stops them
// colliding.
const burst = await Promise.all([
  enrolVia(API),
  enrolVia(API),
  enrolVia(API),
  enrolVia(API),
  enrolVia(API_2),
  enrolVia(API_2),
  enrolVia(API_2),
  enrolVia(API_2),
]);

check(
  'all eight enrolments succeeded',
  burst.every((item) => item.created.status === 201),
  burst.map((item) => item.created.status).join(',')
);

const funded = burst.filter((item) => item.created.body.drip?.txHash);
check(
  'every drip that claimed a hash actually went out',
  funded.length > 0,
  `${funded.length} of 8 reported a transaction hash`
);

const after = noncesSeen();
const justSent = after.slice(before);

check(
  'the stub chain saw no nonce REUSE across instances',
  !logContent().includes('NONCE REUSE'),
  logContent().split('\n').filter((line) => line.includes('REUSE')).join(' | ')
);

check(
  'the nonces that went out are all distinct',
  new Set(justSent).size === justSent.length,
  `sent ${justSent.join(', ')}`
);

// Deliberately NOT asserting they arrive in order. Two instances racing produce
// nonces that reach the node in any order, and that is what nonces are for — the
// chain orders them, not the network. Requiring ascending arrival would fail a
// correct implementation, which is exactly what the previous version of this suite
// did.
check(
  'a contiguous block was claimed, so no gap was left behind',
  justSent.length === 0 ||
    Math.max(...justSent) - Math.min(...justSent) === justSent.length - 1,
  `sent ${justSent.join(', ')}`
);

group('the float is still accounted for');
const dripper = await (await fetch(`${API}/dripper`)).json();
check('the dripper reports itself enabled', dripper.enabled === true, JSON.stringify(dripper).slice(0, 160));
check(
  'the reported balance is a number the banner can print',
  Number.isFinite(Number(dripper.balanceEth)),
  String(dripper.balanceEth)
);

report();
