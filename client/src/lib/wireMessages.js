// THE SIGNED STATEMENTS, IN ONE PLACE.
//
// These strings are a wire format shared with the server, which deploys separately
// and therefore cannot be imported. The test suite imports this module and asserts
// each one is byte-identical to the server's, which is the only thing standing
// between the duplication and silent drift.
//
// Drift here is not cosmetic: the server would reject every signature this client
// produces, and the failure would present as "permissions are broken".
//
// Dependency-free on purpose — `ethers` and nothing else — so Node can load it.

import { getAddress, hexlify, keccak256, randomBytes, toUtf8Bytes } from 'ethers';

const PROFILE_FIELDS = ['displayName', 'dateOfBirth', 'bloodGroup', 'allergies', 'emergencyContact'];

function payloadHash(values) {
  return keccak256(toUtf8Bytes(JSON.stringify(values)));
}

function signedWriteDomainLines({ chainId, verifyingContract }) {
  const id = Number(chainId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid chain id is required to sign this request.');
  return `chainId: ${id}\nverifyingContract: ${getAddress(verifyingContract)}\n`;
}

/** A cryptographically random nonce for a signed one-use write. */
export function newSignatureNonce() {
  return hexlify(randomBytes(32));
}

/** Hash the exact profile fields that an update will write, preserving omitted fields. */
export function profilePayloadHash(fields = {}) {
  return payloadHash(
    PROFILE_FIELDS.map((key) => [
      Object.prototype.hasOwnProperty.call(fields, key),
      typeof fields[key] === 'string' ? fields[key] : '',
    ])
  );
}

/** Must match server/src/controllers/profileController.js `profileMessage`. */
export function profileMessage(address, operation, dataHash, deadline, nonce, domain) {
  return (
    `ApnaRecord profile ${operation}\n` +
    signedWriteDomainLines(domain) +
    `address: ${getAddress(address)}\n` +
    `payloadHash: ${String(dataHash).toLowerCase()}\n` +
    `deadline: ${deadline}\n` +
    `nonce: ${String(nonce).toLowerCase()}`
  );
}

/** Hash every value changed when a recovery code is rotated. */
export function recoveryPayloadHash({ sealed, salt, iterations }) {
  return payloadHash([String(sealed), String(salt), Number(iterations)]);
}

/** Must match server/src/controllers/walletController.js `enrolMessage`. */
export function enrolMessage(address, timestamp) {
  return (
    'ApnaRecord create wallet\n' +
    `address: ${getAddress(address)}\n` +
    `timestamp: ${timestamp}`
  );
}

/** Must match server/src/controllers/walletController.js `dripMessage`. */
export function dripMessage(address, timestamp) {
  return (
    'ApnaRecord request test funds\n' +
    `address: ${getAddress(address)}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Must match server/src/controllers/walletController.js `rotateRecoveryMessage`.
 *
 * Signed by the account's own key. Rotation replaces the wrapping on the local copy —
 * the key and the account are unchanged — so a signature from the key is the only proof
 * that means anything here.
 */
export function rotateRecoveryMessage(address, dataHash, deadline, nonce, domain) {
  return (
    'ApnaRecord rotate recovery code\n' +
    signedWriteDomainLines(domain) +
    `address: ${getAddress(address)}\n` +
    `payloadHash: ${String(dataHash).toLowerCase()}\n` +
    `deadline: ${deadline}\n` +
    `nonce: ${String(nonce).toLowerCase()}`
  );
}

/**
 * Must match server/src/controllers/directoryController.js `identityMessage`.
 */
export function identityMessage(account, label, facility, timestamp, actor = account) {
  const facilityPart =
    facility && String(facility).trim() !== '' ? getAddress(facility) : '';
  return (
    'ApnaRecord register identity\n' +
    `actor: ${getAddress(actor)}\n` +
    `account: ${getAddress(account)}\n` +
    `label: ${String(label || '').slice(0, 80)}\n` +
    `facility: ${facilityPart}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Must match server/src/controllers/directoryController.js `facilityMessage`.
 */
export function facilityMessage(it, name, timestamp, actor = it) {
  return (
    'ApnaRecord register facility\n' +
    `actor: ${getAddress(actor)}\n` +
    `it: ${getAddress(it)}\n` +
    `name: ${String(name || '').slice(0, 120)}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Must match server/src/controllers/directoryController.js `requestMessage`.
 */
export function requestMessage(requestId, patient, recordType, timestamp, actor = patient) {
  return (
    'ApnaRecord record request\n' +
    `actor: ${getAddress(actor)}\n` +
    `requestId: ${Number(requestId)}\n` +
    `patient: ${getAddress(patient)}\n` +
    `recordType: ${String(recordType || '').slice(0, 60)}\n` +
    `timestamp: ${timestamp}`
  );
}
/**
 * Must match server/src/controllers/recordController.js `storeMessage`.
 *
 * The canonical payload array, address checksums, and case normalization must stay
 * identical to the server copy. The visible statement also includes the configured
 * chain and contract so the signature cannot move between deployments.
 */
export function storePayloadHash({
  actor,
  tokenId,
  patient,
  recordHash,
  recordType,
  fileName,
  mimeType,
  contentKey,
  cid,
  plainHash,
}) {
  return payloadHash([
    getAddress(actor),
    Number(tokenId),
    getAddress(patient),
    String(recordHash).toLowerCase(),
    String(recordType || 'UNSPECIFIED'),
    String(fileName || 'record.bin'),
    String(mimeType || 'application/octet-stream'),
    String(contentKey).toLowerCase(),
    String(cid || ''),
    String(plainHash || '').toLowerCase(),
  ]);
}

export function storeMessage({ actor, tokenId, patient, recordHash, deadline, nonce, ...payload }, domain) {
  const dataHash = storePayloadHash({ actor, tokenId, patient, recordHash, ...payload });
  return (
    'ApnaRecord store record\n' +
    signedWriteDomainLines(domain) +
    `actor: ${getAddress(actor)}\n` +
    `tokenId: ${Number(tokenId)}\n` +
    `patient: ${getAddress(patient)}\n` +
    `recordHash: ${String(recordHash).toLowerCase()}\n` +
    `payloadHash: ${dataHash}\n` +
    `deadline: ${deadline}\n` +
    `nonce: ${String(nonce).toLowerCase()}`
  );
}
