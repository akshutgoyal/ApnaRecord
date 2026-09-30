// The email library, and the relay adapters against a stub.
//
// Run from the project root:  node .tmp-test-email.mjs

import '/home/akshut/ApnaRecord/server/src/config/env.js';

import http from 'node:http';
import {
  normaliseEmail,
  emailHmac,
  maskEmail,
} from '/home/akshut/ApnaRecord/server/src/lib/email.js';
import { generateCode, hashCode, timingSafeEqual } from '/home/akshut/ApnaRecord/server/src/lib/codes.js';
import { sendCodeByEmail, emailProviderName } from '/home/akshut/ApnaRecord/server/src/services/emailSender.js';

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
function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

console.log('\nnormaliseEmail');
check('accepts a plain address', normaliseEmail('akshut@example.com') === 'akshut@example.com');
check('lowercases', normaliseEmail('Akshut@Example.COM') === 'akshut@example.com');
check('trims', normaliseEmail('  a@b.co  ') === 'a@b.co');
check('plus-addressing is preserved', normaliseEmail('a+records@b.co') === 'a+records@b.co');
check('rejects empty', throws(() => normaliseEmail('')) !== null);
check('rejects non-strings', throws(() => normaliseEmail(42)) !== null);
check('rejects a missing @', throws(() => normaliseEmail('akshut.example.com')) !== null);
check('rejects two @', throws(() => normaliseEmail('a@b@c.com')) !== null);
check('rejects a dotless domain', throws(() => normaliseEmail('a@localhost')) !== null);
check('rejects a leading-dot domain', throws(() => normaliseEmail('a@.com')) !== null);
check('rejects a double dot', throws(() => normaliseEmail('a@b..co')) !== null);
check('rejects an over-long local part', throws(() => normaliseEmail(`${'x'.repeat(65)}@b.co`)) !== null);
check('rejects an over-long total', throws(() => normaliseEmail(`${'x'.repeat(60)}@${'y'.repeat(200)}.com`)) !== null);
check('rejects whitespace inside', throws(() => normaliseEmail('a b@c.com')) !== null);

console.log('\nmaskEmail');
const masked = maskEmail('akshut@example.com');
check('shows the domain', masked.endsWith('@example.com'), masked);
check('shows exactly one leading character', masked.startsWith('a•••'), masked);
check('does not leak the local part', !masked.includes('kshut'), masked);
check('hides the local length', maskEmail('a@b.co') === maskEmail('aaaaaaaaaaaa@b.co'));

console.log('\nemailHmac');
check('is deterministic', emailHmac('a@b.co') === emailHmac('a@b.co'));
check('ignores case, like the normaliser', emailHmac('A@B.co') === emailHmac('a@b.co'));
check('differs per address', emailHmac('a@b.co') !== emailHmac('c@b.co'));
check('is 64 hex chars', /^[0-9a-f]{64}$/.test(emailHmac('a@b.co')));

console.log('\ncodes');
check('generateCode is six digits', /^\d{6}$/.test(generateCode()));
check('generateCode varies', new Set(Array.from({ length: 200 }, generateCode)).size > 150);
check('a code is bound to its contact', hashCode('contact-a', '123456') !== hashCode('contact-b', '123456'));
check('the same pair is stable', hashCode('contact-a', '123456') === hashCode('contact-a', '123456'));
check('timingSafeEqual matches equal strings', timingSafeEqual('abc', 'abc') === true);
check('timingSafeEqual rejects different strings', timingSafeEqual('abc', 'abd') === false);
check('timingSafeEqual handles a length mismatch', timingSafeEqual('abc', 'abcd') === false);

// ---------------------------------------------------------------- relay adapters

console.log('\nrelay adapters');

let captured = null;
let stubStatus = 200;
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    captured = { url: req.url, auth: req.headers.authorization, apiKey: req.headers['api-key'], body: JSON.parse(body || '{}') };
    res.writeHead(stubStatus, { 'Content-Type': 'application/json' });
    res.end(stubStatus === 200 ? '{"id":"stub"}' : '{"message":"nope"}');
  });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const port = stub.address().port;

// Point the resend adapter at the stub by swapping the URL it calls.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) =>
  realFetch(String(url).replace('https://api.resend.com/emails', `http://127.0.0.1:${port}/emails`), options);

process.env.MASTER_KEY = process.env.MASTER_KEY || 'a'.repeat(64);
process.env.EMAIL_FROM = 'ApnaRecord <no-reply@apnarecord.test>';
process.env.RESEND_API_KEY = 'test-key';

process.env.EMAIL_PROVIDER = 'resend';
check('provider name is reported', emailProviderName() === 'resend');

stubStatus = 200;
const sent = await sendCodeByEmail('person@example.com', '123456');
check('resend reports delivered', sent.delivered === true && sent.provider === 'resend');
check('posts to the relay endpoint', captured.url === '/emails', captured.url);
check('sends the bearer token', captured.auth === 'Bearer test-key', String(captured.auth));
check('sends the configured From', captured.body.from === 'ApnaRecord <no-reply@apnarecord.test>');
check('addresses the right recipient', captured.body.to?.[0] === 'person@example.com');
check('puts the code in the body', String(captured.body.text).includes('123456'));

stubStatus = 500;
let relayError = null;
try {
  await sendCodeByEmail('person@example.com', '123456');
} catch (error) {
  relayError = error;
}
check('a rejected send THROWS rather than reporting success', relayError !== null);
check('the relay error names the status', /500/.test(relayError?.message || ''), relayError?.message);

delete process.env.RESEND_API_KEY;
let keyError = null;
try {
  await sendCodeByEmail('person@example.com', '123456');
} catch (error) {
  keyError = error;
}
check('a missing API key is an error, not a silent skip', /RESEND_API_KEY/.test(keyError?.message || ''));

process.env.EMAIL_PROVIDER = 'mock';
const mocked = await sendCodeByEmail('person@example.com', '654321');
check('mock reports delivered', mocked.delivered === true && mocked.provider === 'mock');
let badProvider = null;
process.env.EMAIL_PROVIDER = 'nonsense';
try {
  await sendCodeByEmail('person@example.com', '123456');
} catch (error) {
  badProvider = error;
}
check('an unknown provider is refused, not guessed at', /EMAIL_PROVIDER/.test(badProvider?.message || ''));

stub.close();
globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
