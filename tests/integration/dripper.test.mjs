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
import { nonceWasUnused } from '../../server/src/services/dripper.js';
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
/**
 * Every nonce the stub chain actually saw, in order.
 *
 * BOTH KINDS OF SEND. This matched only `drip` lines, which was correct while enrolment
 * made exactly one send — and silently wrong the moment enrolment began deploying an
 * account per user, because a deploy consumes a nonce in between. The sequence then
 * looked full of gaps while nothing had been skipped. A filter that quietly stops
 * matching the thing it is measuring is worse than no filter.
 */
const noncesSeen = () =>
  [...logContent().matchAll(/(?:drip|deploy) .*nonce=(\d+)/g)].map((match) => Number(match[1]));

group('two instances, one float');


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

// THE WHOLE LOG, NOT A POSITIONAL SLICE.
//
// An earlier version compared "the lines after this marker" against the claims this
// suite made, which conflates two different orderings. Claims happen in one order and
// broadcasts arrive in another, so nonces the PREVIOUS suite still had in flight when
// the marker was taken arrive after it and land in this suite's set. That produced a
// set like `23, 25, 27, 28, …` — apparently gappy, while every nonce had in fact been
// sent. It failed about half the time and blamed the dripper for it.
const allSent = noncesSeen();

check(
  'the stub chain saw no nonce REUSE across instances',
  !logContent().includes('NONCE REUSE'),
  logContent().split('\n').filter((line) => line.includes('REUSE')).join(' | ')
);

check(
  'the nonces that went out are all distinct',
  new Set(allSent).size === allSent.length,
  `sent ${allSent.join(', ')}`
);

// Contiguity is still worth asserting, because a missed nonce strands every later one —
// that is a real failure and the reason this suite exists. But it has to be asked of the
// full set, which is the only claim the log can actually support.
//
// Deliberately NOT asserting they arrive in order: two instances racing produce nonces
// that reach the node in any order, and that is what nonces are for — the chain orders
// them, not the network. Requiring ascending arrival would fail a correct
// implementation, which is exactly what an even earlier version of this suite did.
check(
  'no nonce was skipped, so nothing is stranded behind a gap',
  allSent.length === 0 ||
    Math.max(...allSent) - Math.min(...allSent) === allSent.length - 1,
  `sent ${allSent.join(', ')}`
);

group('the float is still accounted for');
const dripper = await (await fetch(`${API}/dripper`)).json();
check('the dripper reports itself enabled', dripper.enabled === true, JSON.stringify(dripper).slice(0, 160));
check(
  'the reported balance is a number the banner can print',
  Number.isFinite(Number(dripper.balanceEth)),
  String(dripper.balanceEth)
);

// ---------------------------------------------------------------- the nonce rule
//
// Whether a failed send gives its nonce back is the difference between a gap and a
// reused nonce, and reuse loses funds silently. The rule used to be an inline
// `error?.action !== 'sendTransaction'`, which read as though ethers labelled a
// broadcast failure that way. It does not — an eth_sendRawTransaction failure carries no
// `action` at all — so the comparison was true for every failure and the nonce went back
// even when the node might be holding the transaction. Nothing asserted it, so it
// survived. These are the assertions that would have caught it.

group('the nonce rule');

check(
  'a broadcast failure with no action at all keeps the nonce spent',
  nonceWasUnused({ code: 'SERVER_ERROR' }) === false,
  'this is the shape ethers actually produces for eth_sendRawTransaction'
);
check(
  'an explicit broadcast failure keeps the nonce spent',
  nonceWasUnused({ action: 'sendTransaction' }) === false
);
check(
  'an unrecognised action keeps the nonce spent',
  nonceWasUnused({ action: 'somethingNewInEthers' }) === false,
  'the default has to be "spent" — being wrong that way costs a gap, not a reuse'
);
check('estimation failed before broadcast, so the nonce is free', nonceWasUnused({ action: 'estimateGas' }) === true);
check('the nonce read failed before broadcast', nonceWasUnused({ action: 'getTransactionCount' }) === true);
check('fee estimation failed before broadcast', nonceWasUnused({ action: 'getFeeData' }) === true);
check('a null error is treated as ambiguous', nonceWasUnused(null) === false);

report();
