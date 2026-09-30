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
