// The email verification flow, over real HTTP against a real database.
//
// The API must already be running. tests/run.mjs does that for you.
//
// Run directly:  node tests/integration/contact.test.mjs
//
// The server needs a SHORT cooldown and a generous per-IP cap, otherwise this suite
// cannot request a second code for the same address inside a test run:
//   CONTACT_RESEND_COOLDOWN_MS=2000 CONTACT_MAX_PER_IP=500

import { check, group, report } from '../support/harness.mjs';

const API = process.env.API_URL || 'http://localhost:5000/api';
const API_2 = process.env.API_URL_2;


async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function postTo(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const parallelPost = (path, body, index) =>
  API_2 && index % 2 ? postTo(API_2, path, body) : post(path, body);
const wrongCodeFor = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

const unique = () => `t${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

group('requesting a code');
const address = unique();
const first = await post('/identity/email/request', { email: address });
check('request succeeds', first.status === 200, JSON.stringify(first.body));
check('the mock sender returns the code for the demo', /^\d{6}$/.test(first.body.devCode || ''));
check('the address comes back masked', /^t•••@example\.com$/.test(first.body.contactMasked || ''), first.body.contactMasked);
check('the raw address is NOT echoed back', !JSON.stringify(first.body).includes(address));
check('it warns that no real email was sent', (first.body.note || '').includes('mock'));

group('limits');
const immediate = await post('/identity/email/request', { email: address });
check('an immediate resend is rate limited', immediate.status === 429, `got ${immediate.status}`);
check('the reason is a plain wait, not a hint about which limit', /Try again in/.test(immediate.body.message || ''));

const hourlyAddress = unique();
const hourlyFirst = await post('/identity/email/request', { email: hourlyAddress });
await sleep(2100);
const hourlySecond = await post('/identity/email/request', { email: hourlyAddress });
await sleep(2100);
const hourlyThird = await post('/identity/email/request', { email: hourlyAddress });
check('the rolling per-contact cap allows its configured number', hourlyFirst.status === 200 && hourlySecond.status === 200);
check('the rolling per-contact cap refuses the next request', hourlyThird.status === 429, `got ${hourlyThird.status}`);

const badAddress = await post('/identity/email/request', { email: 'not-an-address' });
check('a malformed address is refused', badAddress.status === 400, `got ${badAddress.status}`);
check('and refused with a readable reason', /email address/i.test(badAddress.body.message || ''));

group('checking a code');
const wrongCode = wrongCodeFor(first.body.devCode);
const wrong = await post('/identity/email/verify', { email: address, code: wrongCode });
check('a wrong code is refused', wrong.status === 400, `got ${wrong.status}`);
check('and says how many attempts remain', /attempt/i.test(wrong.body.message || ''), wrong.body.message);
check('the error names the failure', wrong.body.error === 'CodeInvalid', wrong.body.error);

const never = await post('/identity/email/verify', { email: unique(), code: '123456' });
check('a code nobody requested cannot be used', never.status === 400 && never.body.error === 'CodeExpired', never.body.error);

// Burn the remaining guesses, then prove the right code is refused too.
for (let i = 0; i < 4; i += 1) await post('/identity/email/verify', { email: address, code: wrongCode });
const locked = await post('/identity/email/verify', { email: address, code: first.body.devCode });
check('after five wrong guesses even the CORRECT code is refused', locked.status === 400, `got ${locked.status}`);
check('and says the code is locked', /lock|too many wrong/i.test(locked.body.message || ''), locked.body.message);

group('atomic code issuance and verification');

const requestRaceEmail = unique();
const requestRace = await Promise.all(
  Array.from({ length: 12 }, (_, index) =>
    parallelPost('/identity/email/request', { email: requestRaceEmail }, index)
  )
);
check(
  'concurrent requests issue exactly one code for a contact',
  requestRace.filter((result) => result.status === 200).length === 1 &&
    requestRace.filter((result) => result.status === 429).length === requestRace.length - 1,
  requestRace.map((result) => `${result.status}:${result.body.error || ''}`).join(', ')
);

const verifyRaceEmail = unique();
const verifyRaceCode = await post('/identity/email/request', { email: verifyRaceEmail });
const verifyRace = await Promise.all(
  Array.from({ length: 12 }, (_, index) =>
    parallelPost(
      '/identity/email/verify',
      { email: verifyRaceEmail, code: verifyRaceCode.body.devCode },
      index
    )
  )
);
check(
  'concurrent correct verifications issue only one grant',
  verifyRace.filter((result) => result.status === 200).length === 1,
  verifyRace.map((result) => `${result.status}:${result.body.error || ''}`).join(', ')
);

const guessRaceEmail = unique();
const guessRaceCode = await post('/identity/email/request', { email: guessRaceEmail });
const guessRace = await Promise.all(
  Array.from({ length: 12 }, (_, index) =>
    parallelPost(
      '/identity/email/verify',
      { email: guessRaceEmail, code: wrongCodeFor(guessRaceCode.body.devCode) },
      index
    )
  )
);
check(
  'concurrent wrong guesses cannot exceed the five-attempt lockout',
  guessRace.filter((result) => result.body.error === 'CodeInvalid').length === 5 &&
    guessRace.filter((result) => result.body.error === 'CodeLocked').length === guessRace.length - 5,
  guessRace.map((result) => result.body.error || result.status).join(', ')
);
const rightAfterRace = await post('/identity/email/verify', {
  email: guessRaceEmail,
  code: guessRaceCode.body.devCode,
});
check('the correct code is locked after five concurrent wrong guesses', rightAfterRace.body.error === 'CodeLocked');

group('a grant');
await sleep(2200);
const address2 = unique();
const second = await post('/identity/email/request', { email: address2 });
const grant = await post('/identity/email/verify', { email: address2, code: second.body.devCode });
check('the right code yields a grant', grant.status === 200 && typeof grant.body.token === 'string');
check('the grant says what it CANNOT do', /cannot open/i.test(grant.body.note || ''));
check('the grant carries the mask, not the address', grant.body.contactMasked === second.body.contactMasked);

const lookup1 = await post('/wallet/lookup', { grantToken: grant.body.token });
check('the grant is accepted once', lookup1.status === 200, JSON.stringify(lookup1.body).slice(0, 120));

const lookup2 = await post('/wallet/lookup', { grantToken: grant.body.token });
check('the SAME grant is refused the second time', lookup2.status === 401, `got ${lookup2.status}`);

const forged = await post('/wallet/lookup', { grantToken: 'not-a-real-token' });
check('a forged grant is refused', forged.status === 401, `got ${forged.status}`);

const missing = await post('/wallet/lookup', {});
check('a missing grant is refused', missing.status === 401, `got ${missing.status}`);

const consumeRaceEmail = unique();
const consumeRaceCode = await post('/identity/email/request', { email: consumeRaceEmail });
const consumeRaceGrant = await post('/identity/email/verify', {
  email: consumeRaceEmail,
  code: consumeRaceCode.body.devCode,
});
const consumeRace = await Promise.all(
  Array.from({ length: 12 }, (_, index) =>
    parallelPost('/wallet/lookup', { grantToken: consumeRaceGrant.body.token }, index)
  )
);
check(
  'concurrent uses of one contact grant succeed exactly once',
  consumeRace.filter((result) => result.status === 200).length === 1 &&
    consumeRace.filter((result) => result.status === 401).length === consumeRace.length - 1,
  consumeRace.map((result) => `${result.status}:${result.body.error || ''}`).join(', ')
);

report();
