// The email verification flow, over real HTTP against a real database.
//
// Start the API with a short cooldown and a generous per-IP cap first:
//   CONTACT_RESEND_COOLDOWN_MS=2000 CONTACT_MAX_PER_IP=500 node server/src/index.js
//
// Run from the project root:  node .tmp-test-contact.mjs

const API = process.env.API_URL || 'http://localhost:5000/api';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const unique = () => `t${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('\nrequesting a code');
const address = unique();
const first = await post('/identity/email/request', { email: address });
check('request succeeds', first.status === 200, JSON.stringify(first.body));
check('the mock sender returns the code for the demo', /^\d{6}$/.test(first.body.devCode || ''));
check('the address comes back masked', /^t•••@example\.com$/.test(first.body.contactMasked || ''), first.body.contactMasked);
check('the raw address is NOT echoed back', !JSON.stringify(first.body).includes(address));
check('it warns that no real email was sent', (first.body.note || '').includes('mock'));

console.log('\nlimits');
const immediate = await post('/identity/email/request', { email: address });
check('an immediate resend is rate limited', immediate.status === 429, `got ${immediate.status}`);
check('the reason is a plain wait, not a hint about which limit', /Try again in/.test(immediate.body.message || ''));

const badAddress = await post('/identity/email/request', { email: 'not-an-address' });
check('a malformed address is refused', badAddress.status === 400, `got ${badAddress.status}`);
check('and refused with a readable reason', /email address/i.test(badAddress.body.message || ''));

console.log('\nchecking a code');
const wrong = await post('/identity/email/verify', { email: address, code: '000000' });
check('a wrong code is refused', wrong.status === 400, `got ${wrong.status}`);
check('and says how many attempts remain', /attempt/i.test(wrong.body.message || ''), wrong.body.message);
check('the error names the failure', wrong.body.error === 'CodeInvalid', wrong.body.error);

const never = await post('/identity/email/verify', { email: unique(), code: '123456' });
check('a code nobody requested cannot be used', never.status === 400 && never.body.error === 'CodeExpired', never.body.error);

// Burn the remaining guesses, then prove the right code is refused too.
for (let i = 0; i < 4; i += 1) await post('/identity/email/verify', { email: address, code: '111111' });
const locked = await post('/identity/email/verify', { email: address, code: first.body.devCode });
check('after five wrong guesses even the CORRECT code is refused', locked.status === 400, `got ${locked.status}`);
check('and says the code is locked', /lock|too many wrong/i.test(locked.body.message || ''), locked.body.message);

console.log('\na grant');
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
