// The off-chain directory over HTTP: signed writes, public reads, scoped reads.
//
// The API must already be running. tests/run.mjs does that for you.
//
// NOTE ON COVERAGE. The mock chain answers hasRole=false for every role, so no
// caller here can pass the admin/manager gates — the 201 paths are proved on
// Sepolia (Phase E), not here. What this suite pins down is everything around
// them: malformed input refused, unsigned writes refused, unauthorised writers
// refused, and the read shapes (including facility scoping) exactly as the
// client consumes them.

import { Wallet } from 'ethers';
import { check, group, report, proofHeaders } from '../support/harness.mjs';
import {
  identityMessage,
  facilityMessage,
  requestMessage,
} from '../../client/src/lib/wireMessages.js';

const API = process.env.API_URL || 'http://localhost:5000/api';

async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    headers: await proofHeaders(),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function get(path, signer = null) {
  const response = await fetch(`${API}${path}`, { headers: await proofHeaders(signer) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const stranger = Wallet.createRandom();
const patient = Wallet.createRandom();
const facility = Wallet.createRandom();
const now = () => Date.now();

group('POST /identities refuses what it must');
const unsigned = await post('/identities', {
  account: patient.address,
  label: 'Patient 101',
  facility: '',
  timestamp: now(),
});
check('an unsigned write is refused', unsigned.status === 400, `got ${unsigned.status}`);
check('and names the missing signature', unsigned.body.error === 'SignatureRequired', unsigned.body.error);

const malformed = await post('/identities', {
  account: 'not-an-address',
  label: 'x',
  facility: '',
  timestamp: now(),
  signature: '0x00',
});
check('a malformed account is refused', malformed.status === 400, `got ${malformed.status}`);

const strangerTime = now();
const strangerSig = await stranger.signMessage(
  identityMessage(patient.address, 'Patient 101', '', strangerTime)
);
const unauthorised = await post('/identities', {
  account: patient.address,
  label: 'Patient 101',
  facility: '',
  timestamp: strangerTime,
  signature: strangerSig,
});
check(
  'a writer the chain does not authorise is refused',
  unauthorised.status === 403 && unauthorised.body.error === 'NotAuthorized',
  `${unauthorised.status} ${unauthorised.body.error}`
);

group('POST /facilities refuses what it must');
const facilityTime = now();
const facilitySig = await stranger.signMessage(
  facilityMessage(facility.address, 'City Care', facilityTime)
);
const facilityDenied = await post('/facilities', {
  it: facility.address,
  name: 'City Care',
  timestamp: facilityTime,
  signature: facilitySig,
});
check(
  'a non-admin cannot register a facility',
  facilityDenied.status === 403,
  `got ${facilityDenied.status} ${facilityDenied.body.error}`
);

const nameless = await post('/facilities', {
  it: facility.address,
  name: '  ',
  timestamp: now(),
  signature: facilitySig,
});
check('a missing name is refused before any signature check', nameless.status === 400, `got ${nameless.status}`);

group('POST /requests refuses what it must');
const requestTime = now();
const requestSig = await stranger.signMessage(requestMessage(999999, patient.address, 'MRI_SCAN', requestTime));
const requestDenied = await post('/requests', {
  requestId: 999999,
  patient: patient.address,
  recordType: 'MRI_SCAN',
  timestamp: requestTime,
  signature: requestSig,
});
check(
  'a writer without MANAGER_ROLE is refused',
  requestDenied.status === 403,
  `got ${requestDenied.status} ${requestDenied.body.error}`
);

group('directory reads');
const detail = await get(`/facilities/${facility.address}`);
check('facility detail answers', detail.status === 200, `got ${detail.status}`);
check('an unregistered facility reports itself honestly', detail.body.registeredOnChain === false, JSON.stringify(detail.body).slice(0, 120));
check('with an empty link set', Array.isArray(detail.body.linkedPatients), JSON.stringify(detail.body).slice(0, 120));

// Signed AS the patient. The route is scoped to its subject, so asking about
// someone else's links is a 403 — correct, and not what this assertion is about.
const links = await get(`/patients/${patient.address}/links`, patient);
check('patient links answer', links.status === 200, `got ${links.status}`);
check('with linked and pending arrays', Array.isArray(links.body.linked) && Array.isArray(links.body.pending));

const badFacility = await get('/facilities/not-an-address');
check('a malformed facility is refused', badFacility.status === 400, `got ${badFacility.status}`);

group('scoped reads');
const scopedBad = await get('/records?facility=not-an-address');
check('a malformed scope is refused, not silently unscoped', scopedBad.status === 400, `got ${scopedBad.status}`);

const scoped = await get(`/records?facility=${facility.address}`);
check('a scoped read answers', scoped.status === 200, `got ${scoped.status}`);
check('and marks itself scoped', scoped.body.scoped === true, JSON.stringify(scoped.body).slice(0, 120));

// ---------------------------------------------------------------- the pending list
//
// The admin console's first request, and the only read that carries masked email
// addresses. It used to take its own signature per call; it now takes the read token and
// checks the role against the chain, so what matters is that the role check survived.
//
// Asserted by ERROR CODE rather than by "not 200". A 401 for the wrong reason looks
// identical to a 401 for the right one, which is exactly how a real regression slipped
// past a manual check earlier: the OTP limiter refused the request and the refusal read
// like the binding rule working.
group('the pending list is gated by wallet AND by role');

// A raw fetch, NOT get(). get() attaches the harness's proof, so asking it for the
// anonymous case actually asks as a wallet -- which is how this check first failed with
// a 403 and read like a bug in the gate.
const pendingAnonResponse = await fetch(`${API}/admin/pending`);
const pendingAnon = {
  status: pendingAnonResponse.status,
  body: await pendingAnonResponse.json().catch(() => ({})),
};
check(
  'an anonymous caller is refused, and told why',
  pendingAnon.status === 401 && pendingAnon.body.error === 'ProofRequired',
  `${pendingAnon.status} ${pendingAnon.body.error}`
);

const pendingStranger = await get('/admin/pending', stranger);
check(
  'a real wallet holding no role is refused with NotAuthorized',
  pendingStranger.status === 403 && pendingStranger.body.error === 'NotAuthorized',
  `${pendingStranger.status} ${pendingStranger.body.error}`
);

check(
  'and the refusal names the address that was refused',
  typeof pendingStranger.body.message === 'string' &&
    pendingStranger.body.message.toLowerCase().includes(stranger.address.toLowerCase()),
  pendingStranger.body.message
);

report();
