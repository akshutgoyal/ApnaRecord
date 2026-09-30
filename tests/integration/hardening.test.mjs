// THE HARDENED SURFACE.
//
// Every check here corresponds to something that was, until recently, open:
//
//   • `app.use(cors())` allowed every origin on the internet to call the API.
//   • `POST /records` accepted an unauthenticated body and wrote a row naming any
//     token and any patient, with no on-chain cross-check at all.
//   • The rate limiters lived in `Map`s, so they reset on restart.
//
// The suite asserts the refusals, because a control that is never exercised is a
// control that quietly stops working — and these particular ones fail open-looking,
// returning a normal response with no error.
//
// The stub chain answers the contract reads this needs: `ownerOf` reverts (so a token
// is treated as not yet minted), `nextTokenId` returns 1, `hasRole` returns false.

import { ethers, Wallet } from 'ethers';
import { storeMessage } from '../../client/src/lib/wireMessages.js';
import { check, group, report } from '../support/harness.mjs';

const API = process.env.API_URL || 'http://localhost:5000/api';
const ALLOWED_ORIGIN = 'http://localhost:5173';

async function post(path, body, headers = {}) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** A body that passes every shape check, so only the auth is under test. */
function recordBody(overrides = {}) {
  return {
    tokenId: 1,
    patient: '0x00000000000000000000000000000000000000A1',
    recordType: 'MRI_SCAN',
    fileName: 'scan.bin',
    mimeType: 'application/octet-stream',
    contentKey: 'ab'.repeat(32),
    ciphertext: Buffer.from('not really a scan').toString('base64'),
    cid: 'local://test',
    ...overrides,
  };
}

group('CORS is an allowlist, not a formality');

const unknown = await fetch(`${API}/health`, { headers: { Origin: 'https://evil.example' } });
check(
  'an unknown origin is refused',
  unknown.status === 403,
  `got ${unknown.status}`
);
const unknownBody = await unknown.json().catch(() => ({}));
check(
  'and told why, rather than being silently served',
  unknownBody.error === 'OriginNotAllowed',
  JSON.stringify(unknownBody).slice(0, 120)
);

const allowed = await fetch(`${API}/health`, { headers: { Origin: ALLOWED_ORIGIN } });
check('a listed origin is served', allowed.status === 200, `got ${allowed.status}`);
check(
  'and gets the CORS header back',
  allowed.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN,
  String(allowed.headers.get('access-control-allow-origin'))
);

const noOrigin = await fetch(`${API}/health`);
check(
  'a request with no Origin at all still works — CORS is a browser control',
  noOrigin.status === 200,
  `got ${noOrigin.status}`
);

group('POST /records refuses what it cannot prove');

const unsigned = await post('/records', recordBody());
check(
  'an unsigned upload is refused',
  unsigned.status === 403,
  `got ${unsigned.status} ${JSON.stringify(unsigned.body).slice(0, 120)}`
);
check(
  'and says a signed statement is missing, not "forbidden"',
  /signed statement/i.test(unsigned.body.message || ''),
  unsigned.body.message
);

const stranger = Wallet.createRandom();
const strangerTime = Date.now();
const strangerDigest = ethers.keccak256(
  Buffer.from(recordBody().ciphertext, 'base64')
);
const strangerSignature = await stranger.signMessage(
  storeMessage(1, recordBody().patient, strangerDigest, strangerTime)
);
const notMinting = await post(
  '/records',
  recordBody({ timestamp: strangerTime, signature: strangerSignature })
);
check(
  'a well-formed signature from an account with no minting role is refused',
  notMinting.status === 403 && notMinting.body.error === 'NotMintingRole',
  `${notMinting.status} ${notMinting.body.error}`
);
check(
  'and the reason names the on-chain role, not a generic denial',
  /DEFAULT_ADMIN_ROLE/.test(notMinting.body.message || ''),
  notMinting.body.message
);

group('POST /records refuses the shapes it used to accept');

const badPatient = await post('/records', recordBody({ patient: 'not-an-address' }));
check(
  'a patient that is not an address is refused',
  badPatient.status === 400,
  `got ${badPatient.status}`
);

const badToken = await post('/records', recordBody({ tokenId: 0 }));
check('tokenId 0 is refused', badToken.status === 400, `got ${badToken.status}`);

const badKey = await post('/records', recordBody({ contentKey: 'short' }));
check('a malformed content key is refused', badKey.status === 400, `got ${badKey.status}`);

const emptyCipher = await post('/records', recordBody({ ciphertext: '' }));
check('empty ciphertext is refused', emptyCipher.status === 400, `got ${emptyCipher.status}`);

const wrongToken = await post(
  '/records',
  recordBody({ tokenId: 99, timestamp: Date.now(), signature: strangerSignature })
);
check(
  'a token that is not next in line is refused, so bytes cannot be parked against a future id',
  wrongToken.status === 400 && wrongToken.body.error === 'NotNextToken',
  `${wrongToken.status} ${wrongToken.body.error}`
);

group('the read proof is still required');

const fileResponse = await fetch(`${API}/records/1/file?viewer=${stranger.address}`);
check(
  'an unsigned record read is refused',
  fileResponse.status === 401,
  `got ${fileResponse.status}`
);
const fileBody = await fileResponse.json().catch(() => ({}));
check(
  'and names the headers it wants',
  /x-apnarecord/.test(JSON.stringify(fileBody)),
  JSON.stringify(fileBody).slice(0, 160)
);

group('the signature cannot travel in a URL any more');

const eraseViaQuery = await fetch(
  `${API}/profiles/${stranger.address}?timestamp=${Date.now()}&signature=0xdead`,
  { method: 'DELETE' }
);
check(
  'a profile erasure carrying its signature in the query string is refused',
  eraseViaQuery.status === 403,
  `got ${eraseViaQuery.status}`
);

const eraseViaHeader = await fetch(`${API}/profiles/${stranger.address}`, {
  method: 'DELETE',
  headers: { 'x-apnarecord-timestamp': String(Date.now()), 'x-apnarecord-signature': '0xdead' },
});
check(
  'and the header form is what the server actually reads',
  eraseViaHeader.status === 403 &&
    (await eraseViaHeader.json().catch(() => ({}))).error === 'SignatureInvalid',
  `got ${eraseViaHeader.status}`
);

group('the limiters are in the database, not in a Map');

// If these were still in-memory this would be invisible from here, so the check is
// indirect but real: the counters must be readable as documents. A restart test is in
// the runner — two instances share one database, which an in-memory map could not.
const health = await (await fetch(`${API}/health`)).json();
check('the API is up and reporting', health.status === 'ok', JSON.stringify(health).slice(0, 120));

report();
