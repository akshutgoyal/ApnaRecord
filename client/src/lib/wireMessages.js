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

import { getAddress } from 'ethers';

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
export function rotateRecoveryMessage(address, timestamp) {
  return (
    'ApnaRecord rotate recovery code\n' +
    `address: ${getAddress(address)}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Must match server/src/controllers/directoryController.js `identityMessage`.
 */
export function identityMessage(account, label, facility, timestamp) {
  const facilityPart =
    facility && String(facility).trim() !== '' ? getAddress(facility) : '';
  return (
    'ApnaRecord register identity\n' +
    `account: ${getAddress(account)}\n` +
    `label: ${String(label || '').slice(0, 80)}\n` +
    `facility: ${facilityPart}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Must match server/src/controllers/directoryController.js `facilityMessage`.
 */
export function facilityMessage(it, name, timestamp) {
  return (
    'ApnaRecord register facility\n' +
    `it: ${getAddress(it)}\n` +
    `name: ${String(name || '').slice(0, 120)}\n` +
    `timestamp: ${timestamp}`
  );
}

/**
 * Must match server/src/controllers/directoryController.js `requestMessage`.
 */
export function requestMessage(requestId, patient, recordType, timestamp) {
  return (
    'ApnaRecord record request\n' +
    `requestId: ${Number(requestId)}\n` +
    `patient: ${getAddress(patient)}\n` +
    `recordType: ${String(recordType || '').slice(0, 60)}\n` +
    `timestamp: ${timestamp}`
  );
}
/**
 * Must match server/src/controllers/recordController.js `storeMessage`.
 *
 * `recordHash` is lowercased on both sides. ethers already returns lowercase hex from
 * keccak256, but the two sides independently build this string and a stray checksum
 * case would produce a signature that verifies nowhere.
 */
export function storeMessage(tokenId, patient, recordHash, timestamp) {
  return (
    'ApnaRecord store record\n' +
    `tokenId: ${Number(tokenId)}\n` +
    `patient: ${getAddress(patient)}\n` +
    `recordHash: ${String(recordHash).toLowerCase()}\n` +
    `timestamp: ${timestamp}`
  );
}
