// Wallet enrolment and lookup, end to end over HTTP.
//
// Run from the project root:  node tests/integration/wallet.test.mjs
// Requires the API pointed at the mock chain, with a funded dripper.

import fs from 'node:fs';
import { Wallet, getAddress, hexlify, id, randomBytes } from 'ethers';
import {
  createWallet,
  sealPrivateKey,
  generateRecoveryCode,
  openPrivateKey,
} from '../../client/src/lib/keystore.js';
import {
  enrolMessage,
  newSignatureNonce,
  profileMessage as clientProfileMessage,
  profilePayloadHash,
  recoveryPayloadHash,
  requestMessage,
  rotateRecoveryMessage as clientRotateRecoveryMessage,
  storeMessage as clientStoreMessage,
  storePayloadHash,
} from '../../client/src/lib/wireMessages.js';
import {
  enrolMessage as serverEnrolMessage,
  recoveryPayloadHash as serverRecoveryPayloadHash,
  rotateRecoveryMessage as serverRotateMessage,
} from '../../server/src/controllers/walletController.js';
import {
  storeMessage as serverStoreMessage,
  storePayloadHash as serverStorePayloadHash,
} from '../../server/src/controllers/recordController.js';
import {
  profileMessage as serverProfileMessage,
  profilePayloadHash as serverProfilePayloadHash,
} from '../../server/src/controllers/profileController.js';
import { READ_DOMAIN, READ_TYPES } from '../../server/src/lib/readProof.js';
import { check, group, report, proofHeaders } from '../support/harness.mjs';

const API = process.env.API_URL || 'http://localhost:5000/api';
const MOCK_LOG = process.env.MOCK_LOG || '/tmp/mock-chain.log';
const CHAIN = process.env.CHAIN || 'http://127.0.0.1:8545';
const WRITE_DOMAIN = {
  chainId: Number(process.env.CHAIN_ID || 84532),
  verifyingContract:
    process.env.CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000abc',
};
const profileWriteMessage = (...args) => clientProfileMessage(...args, WRITE_DOMAIN);
const recoveryWriteMessage = (...args) => clientRotateRecoveryMessage(...args, WRITE_DOMAIN);
const storeWriteMessage = (payload) => clientStoreMessage(payload, WRITE_DOMAIN);
const otherDeployment = {
  chainId: WRITE_DOMAIN.chainId + 1,
  verifyingContract: '0x0000000000000000000000000000000000000002',
};


async function post(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
// Reads now carry a proof: most of these endpoints return off-chain rows.
const get = async (path) => (await fetch(`${API}${path}`, { headers: await proofHeaders() })).json();

async function setMockAccountOwner(account, owner) {
  const response = await fetch(CHAIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'mock_setAccountOwner',
      params: [account, owner],
    }),
  });
  return response.ok;
}

async function setMockRole(role, account, held) {
  const response = await fetch(CHAIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'mock_setRole',
      params: [role, account, held],
    }),
  });
  return response.ok;
}

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
    // Sent, not omitted. This suite used to enrol without a role, so every row it
    // created looked like a registration whose selector had failed -- and the role path
    // had no test at all. A caller that skips the input proves nothing about the feature
    // that consumes it.
    requestedRole: 'auditor',
    sealed: sealed.sealed,
    salt: sealed.salt,
    iterations: sealed.iterations,
    grantToken: grant.body.token,
    timestamp,
    signature,
  });
  // Two addresses now, and mixing them up silently tests the wrong thing.
  //
  //   `owner`   the key, which signs and which the account accepts `execute` from.
  //             It is never the on-chain owner of a record.
  //   `address` the account the server deployed. This is what owns records, what the
  //             server stores the row against, and what a lookup must name.
  return {
    email,
    owner: address,
    address: created.body.address || address,
    privateKey,
    recoveryCode,
    created,
  };
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
const probeNonce = `0x${'11'.repeat(32)}`;
const probeDeadline = 1234567890;
const probeUpload = {
  actor: probe,
  uploadId: `0x${'22'.repeat(32)}`,
  tokenId: 7,
  patient: probe,
  recordHash: probeDigest,
  recordType: 'MRI_SCAN',
  fileName: 'scan.pdf',
  mimeType: 'application/pdf',
  contentKey: 'ab'.repeat(32),
  cid: 'sha256:abc123',
  plainHash: `0x${'cd'.repeat(32)}`,
};
check(
  'the client and server agree on the store message byte for byte',
  storeWriteMessage({ ...probeUpload, deadline: probeDeadline, nonce: probeNonce }) ===
    serverStoreMessage({ ...probeUpload, deadline: probeDeadline, nonce: probeNonce }),
  storeWriteMessage({ ...probeUpload, deadline: probeDeadline, nonce: probeNonce })
);
check(
  'the client and server agree on the complete upload payload hash',
  storePayloadHash(probeUpload) === serverStorePayloadHash(probeUpload),
  storePayloadHash(probeUpload)
);
check(
  'the upload signature binds every stored metadata and key field',
  ['actor', 'uploadId', 'tokenId', 'patient', 'recordHash', 'recordType', 'fileName', 'mimeType', 'contentKey', 'cid', 'plainHash'].every(
    (key) => {
      const replacement =
        key === 'actor' || key === 'patient'
          ? '0x0000000000000000000000000000000000000002'
          : key === 'tokenId'
            ? 8
            : key === 'uploadId'
              ? `0x${'33'.repeat(32)}`
            : key === 'recordHash' || key === 'plainHash'
              ? `0x${'ef'.repeat(32)}`
              : `${probeUpload[key]}-changed`;
      const changed = { ...probeUpload, [key]: replacement };
      return storeWriteMessage({ ...probeUpload, deadline: probeDeadline, nonce: probeNonce }) !==
        storeWriteMessage({ ...changed, deadline: probeDeadline, nonce: probeNonce });
    }
  ) &&
    clientStoreMessage(
      { ...probeUpload, deadline: probeDeadline, nonce: probeNonce },
      otherDeployment
    ) !== storeWriteMessage({ ...probeUpload, deadline: probeDeadline, nonce: probeNonce })
);

const profileFields = { displayName: 'Alice', allergies: '' };
const profileHash = profilePayloadHash(profileFields);
check(
  'the client and server agree on the profile payload hash and message',
  profileHash === serverProfilePayloadHash(profileFields) &&
    profileWriteMessage(probe, 'update', profileHash, probeDeadline, probeNonce) ===
      serverProfileMessage(probe, 'update', profileHash, probeDeadline, probeNonce)
);
check(
  'profile signatures bind the deployment, operation, field values and field presence',
  profileWriteMessage(probe, 'update', profileHash, probeDeadline, probeNonce) !==
    profileWriteMessage(probe, 'delete', serverProfilePayloadHash({}), probeDeadline, probeNonce) &&
    clientProfileMessage(probe, 'update', profileHash, probeDeadline, probeNonce, otherDeployment) !==
      profileWriteMessage(probe, 'update', profileHash, probeDeadline, probeNonce) &&
    profileHash !== profilePayloadHash({ displayName: 'Mallory', allergies: '' }) &&
    profileHash !== profilePayloadHash({ displayName: 'Alice' })
);

group('enrolment');
const first = await enrolOne();
check('an enrolment with both proofs succeeds', first.created.status === 201, JSON.stringify(first.created.body).slice(0, 200));
check('a drip transaction comes back', Boolean(first.created.body.drip?.txHash), JSON.stringify(first.created.body.drip));
const firstDripLog = fs.existsSync(MOCK_LOG) ? fs.readFileSync(MOCK_LOG, 'utf8') : '';
check(
  'the drip funds the owner key that pays account transactions',
  firstDripLog.split('\n').some((line) => line.includes('drip ') && line.includes(`→ ${first.owner.toLowerCase()} `)),
  first.owner
);
check('the address is echoed back masked', /^w•••@example\.com$/.test(first.created.body.emailMasked || ''), first.created.body.emailMasked);

group('what was actually stored');
const fetched = await get(`/wallet/${first.address}`);
const opened = await openPrivateKey(
  { sealed: fetched.enrolment.sealed, salt: fetched.enrolment.salt, iterations: fetched.enrolment.iterations },
  first.recoveryCode
);
check('the sealed blob opens with the recovery code', new Wallet(opened).address === first.owner);
check(
  'and the key it opens to is NOT the account — the two are different addresses',
  first.owner.toLowerCase() !== first.address.toLowerCase(),
  `${first.owner} vs ${first.address}`
);
check('the blob does not contain the private key', !fetched.enrolment.sealed.includes(first.privateKey.slice(2)));
check('the identity comes back as a masked address', /^w•••@example\.com$/.test(fetched.enrolment.emailMasked || ''), fetched.enrolment.emailMasked);
check('the raw address is not stored, only the mask', !JSON.stringify(fetched.enrolment).includes(first.email));

group('account identity across API reads and writes');
const profileOwner = Wallet.createRandom();
const profileAccount = Wallet.createRandom().address;
check('the stub account owner is set', await setMockAccountOwner(profileAccount, profileOwner.address));
const issuedAt = Date.now();
const nonce = hexlify(randomBytes(32));
const readSignature = await profileOwner.signTypedData(READ_DOMAIN(), READ_TYPES, {
  tokenId: 0,
  viewer: getAddress(profileAccount),
  issuedAt,
  nonce,
});
const session = await post('/auth/session', {
  viewer: profileAccount,
  issuedAt,
  nonce,
  signature: readSignature,
});
check(
  'an account-owner signature creates a session for the account identity',
  session.status === 200 && session.body.viewer === getAddress(profileAccount),
  `${session.status} ${session.body.viewer || session.body.error}`
);

const profileFieldsToSave = { displayName: 'Account Owner' };
const profileDeadline = Date.now() + 60_000;
const profileNonce = newSignatureNonce();
const profileHashForSave = profilePayloadHash(profileFieldsToSave);
const profileSignature = await profileOwner.signMessage(
  profileWriteMessage(profileAccount, 'update', profileHashForSave, profileDeadline, profileNonce)
);
const substitutedProfile = await post(`/profiles/${profileAccount}`, {
  displayName: 'Changed after signing',
  deadline: profileDeadline,
  nonce: profileNonce,
  signature: profileSignature,
});
check(
  'a profile field changed after signing is refused',
  substitutedProfile.status === 403 && substitutedProfile.body.error === 'SignatureInvalid',
  `${substitutedProfile.status} ${substitutedProfile.body.error || ''}`
);

const deleteWithUpdateSignature = await fetch(`${API}/profiles/${profileAccount}`, {
  method: 'DELETE',
  headers: {
    'x-apnarecord-deadline': String(profileDeadline),
    'x-apnarecord-nonce': profileNonce,
    'x-apnarecord-signature': profileSignature,
  },
});
check('an update signature cannot be reused to delete a profile', deleteWithUpdateSignature.status === 403);

const profileSave = await post(`/profiles/${profileAccount}`, {
  ...profileFieldsToSave,
  deadline: profileDeadline,
  nonce: profileNonce,
  signature: profileSignature,
});
check(
  'an EIP-1271 account signature authorizes its profile write',
  profileSave.status === 200 && profileSave.body.profile?.displayName === 'Account Owner',
  `${profileSave.status} ${profileSave.body.error || ''}`
);

const profileReplay = await post(`/profiles/${profileAccount}`, {
  ...profileFieldsToSave,
  deadline: profileDeadline,
  nonce: profileNonce,
  signature: profileSignature,
});
check(
  'a successful profile signature cannot be replayed',
  profileReplay.status === 409,
  `${profileReplay.status} ${profileReplay.body.error || ''}`
);

const profileReadResponse = await fetch(`${API}/profiles/${profileAccount}`, {
  headers: { Authorization: `Bearer ${session.body.token}` },
});
const profileRead = await profileReadResponse.json().catch(() => ({}));
check(
  'the account session reads its own profile as the subject',
  profileReadResponse.status === 200 && profileRead.profile?.displayName === 'Account Owner',
  `${profileReadResponse.status} ${profileRead.error || ''}`
);

const deleteDeadline = Date.now() + 60_000;
const deleteNonce = newSignatureNonce();
const deleteSignature = await profileOwner.signMessage(
  profileWriteMessage(profileAccount, 'delete', profilePayloadHash({}), deleteDeadline, deleteNonce)
);
const profileDeleteResponse = await fetch(`${API}/profiles/${profileAccount}`, {
  method: 'DELETE',
  headers: {
    'x-apnarecord-deadline': String(deleteDeadline),
    'x-apnarecord-nonce': deleteNonce,
    'x-apnarecord-signature': deleteSignature,
  },
});
check('a separate delete signature can erase the profile', profileDeleteResponse.status === 200);

const requestId = Date.now();
const requestPatient = Wallet.createRandom().address;
const requestTimestamp = Date.now();
const requestSignature = await profileOwner.signMessage(
  requestMessage(requestId, requestPatient, 'MRI_SCAN', requestTimestamp, profileAccount)
);
check(
  'the account receives the manager role in the stub',
  await setMockRole(id('MANAGER_ROLE'), profileAccount, true)
);
const savedRequest = await post('/requests', {
  actor: profileAccount,
  requestId,
  patient: requestPatient,
  recordType: 'MRI_SCAN',
  timestamp: requestTimestamp,
  signature: requestSignature,
});
check(
  'an account signature authorizes the acting account role check',
  savedRequest.status === 201 && savedRequest.body.request?.requester === profileAccount.toLowerCase(),
  `${savedRequest.status} ${savedRequest.body.error || ''}`
);

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

// -------------------------------------------------------------- recovery rotation
//
// Rotation is only worth anything if the OLD code genuinely stops working. "The write
// succeeded" and "the new code opens it" are both satisfiable by a rename; the
// assertion that carries the feature is the one proving the previous code now fails.

group('recovery code rotation');

const probeRecovery = { sealed: 'sealed-value', salt: 'salt-value', iterations: 600000 };
const probeRecoveryHash = recoveryPayloadHash(probeRecovery);
check(
  'the client and server agree on recovery payload hash and message',
  probeRecoveryHash === serverRecoveryPayloadHash(probeRecovery) &&
    recoveryWriteMessage(probe, probeRecoveryHash, probeDeadline, probeNonce) ===
      serverRotateMessage(probe, probeRecoveryHash, probeDeadline, probeNonce)
);
check(
  'the recovery signature binds the address, payload, deadline and nonce',
  recoveryWriteMessage(probe, probeRecoveryHash, probeDeadline, probeNonce) !==
    recoveryWriteMessage('0x0000000000000000000000000000000000000002', probeRecoveryHash, probeDeadline, probeNonce) &&
    recoveryWriteMessage(probe, recoveryPayloadHash({ ...probeRecovery, salt: 'changed' }), probeDeadline, probeNonce) !==
      recoveryWriteMessage(probe, probeRecoveryHash, probeDeadline, probeNonce) &&
    recoveryWriteMessage(probe, probeRecoveryHash, probeDeadline + 1, probeNonce) !==
      recoveryWriteMessage(probe, probeRecoveryHash, probeDeadline, probeNonce) &&
    recoveryWriteMessage(probe, probeRecoveryHash, probeDeadline, `0x${'22'.repeat(32)}`) !==
      recoveryWriteMessage(probe, probeRecoveryHash, probeDeadline, probeNonce) &&
    clientRotateRecoveryMessage(
      probe,
      probeRecoveryHash,
      probeDeadline,
      probeNonce,
      otherDeployment
    ) !== recoveryWriteMessage(probe, probeRecoveryHash, probeDeadline, probeNonce)
);

const rot = await enrolOne();
// Two addresses, and they are not interchangeable: the enrolment row is keyed by the
// DEPLOYED ACCOUNT, while the sealed copy belongs to its OWNER key. Only the key can
// sign, so the path names the account and the signature comes from the owner.
const rotAccount = rot.address;
const rotOwner = rot.owner;
const oldCode = rot.recoveryCode;
const newCode = generateRecoveryCode();

const before = (await get(`/wallet/${rotAccount}`)).enrolment;
check(
  'the old code opens the blob as it stands',
  new Wallet(await openPrivateKey({ sealed: before.sealed, salt: before.salt }, oldCode)).address === rotOwner
);

const resealed = await sealPrivateKey(rot.privateKey, newCode);
const rotationPayload = {
  sealed: resealed.sealed,
  salt: resealed.salt,
  iterations: resealed.iterations,
};
const rotDeadline = Date.now() + 60_000;
const rotNonce = newSignatureNonce();
const rotSignature = await new Wallet(rot.privateKey).signMessage(
  recoveryWriteMessage(rotAccount, recoveryPayloadHash(rotationPayload), rotDeadline, rotNonce)
);
const changedRotation = await post(`/wallet/${rotAccount}/rotate-recovery`, {
  ...rotationPayload,
  iterations: resealed.iterations + 1,
  deadline: rotDeadline,
  nonce: rotNonce,
  signature: rotSignature,
});
check('changed recovery parameters are refused', changedRotation.status === 403);

const rotatedBody = {
  ...rotationPayload,
  deadline: rotDeadline,
  nonce: rotNonce,
  signature: rotSignature,
};
const rotated = await post(`/wallet/${rotAccount}/rotate-recovery`, rotatedBody);
check('the rotation is accepted', rotated.status === 200, JSON.stringify(rotated.body).slice(0, 200));
const rotationReplay = await post(`/wallet/${rotAccount}/rotate-recovery`, rotatedBody);
check('a successful recovery rotation cannot be replayed', rotationReplay.status === 409);

const after = (await get(`/wallet/${rotAccount}`)).enrolment;
check('the stored blob is the new one', after.sealed === resealed.sealed, 'sealed value did not change');
check(
  'the new code opens the same key',
  new Wallet(await openPrivateKey({ sealed: after.sealed, salt: after.salt }, newCode)).address === rotOwner
);

let oldStillWorks = false;
try {
  await openPrivateKey({ sealed: after.sealed, salt: after.salt }, oldCode);
  oldStillWorks = true;
} catch {
  oldStillWorks = false;
}
check('the OLD code no longer opens it — the whole point of rotating', !oldStillWorks);

group('rotation refuses what it should');

const impostor = createWallet();
const forgedDeadline = Date.now() + 60_000;
const forgedNonce = newSignatureNonce();
const forged = await post(`/wallet/${rotAccount}/rotate-recovery`, {
  ...rotationPayload,
  deadline: forgedDeadline,
  nonce: forgedNonce,
  signature: await new Wallet(impostor.privateKey).signMessage(
    recoveryWriteMessage(rotAccount, recoveryPayloadHash(rotationPayload), forgedDeadline, forgedNonce)
  ),
});
check('a signature from a key that does not own this wallet is refused', forged.status === 403, `got ${forged.status}`);

const neverEnrolled = createWallet();
const unknownDeadline = Date.now() + 60_000;
const unknownNonce = newSignatureNonce();
const unknown = await post(`/wallet/${neverEnrolled.address}/rotate-recovery`, {
  ...rotationPayload,
  deadline: unknownDeadline,
  nonce: unknownNonce,
  signature: await new Wallet(neverEnrolled.privateKey).signMessage(
    recoveryWriteMessage(
      neverEnrolled.address,
      recoveryPayloadHash(rotationPayload),
      unknownDeadline,
      unknownNonce
    )
  ),
});
check('an address that was never enrolled is refused', unknown.status === 404, `got ${unknown.status}`);

const weakDeadline = Date.now() + 60_000;
const weakNonce = newSignatureNonce();
const weakPayload = { ...rotationPayload, iterations: 1 };
const weak = await post(`/wallet/${rotAccount}/rotate-recovery`, {
  ...weakPayload,
  deadline: weakDeadline,
  nonce: weakNonce,
  signature: await new Wallet(rot.privateKey).signMessage(
    recoveryWriteMessage(rotAccount, recoveryPayloadHash(weakPayload), weakDeadline, weakNonce)
  ),
});
check('a downgraded iteration count is refused', weak.status === 400, `got ${weak.status}`);

const afterWeak = (await get(`/wallet/${rotAccount}`)).enrolment;
check(
  'and a refused rotation changed nothing',
  afterWeak.sealed === resealed.sealed && afterWeak.iterations === resealed.iterations,
  `iterations now ${afterWeak.iterations}`
);

const staleDeadline = Date.now() - 1;
const staleNonce = newSignatureNonce();
const stale = await post(`/wallet/${rotAccount}/rotate-recovery`, {
  ...rotationPayload,
  deadline: staleDeadline,
  nonce: staleNonce,
  signature: await new Wallet(rot.privateKey).signMessage(
    recoveryWriteMessage(rotAccount, recoveryPayloadHash(rotationPayload), staleDeadline, staleNonce)
  ),
});
check('an expired signature is refused', stale.status === 403, `got ${stale.status}`);

report();
