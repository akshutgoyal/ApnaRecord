// PROOF OF VIEWER, client half.
//
// The server will not release a record to a caller who merely *names* the viewer.
// This signs a structured message proving the caller holds that viewer's key, and
// returns the headers the read must carry.
//
// The message is EIP-712 rather than a plain string so the user sees typed fields
// in their wallet instead of a wall of hex, and so the domain binds the signature
// to this contract on this chain — a signature harvested here cannot be replayed
// against another deployment.

import { getAddress, hexlify, randomBytes } from 'ethers';
// With the extension so this module can be imported by Node as well as Vite. That
// matters here: the read proof is a contract between two codebases, and the test
// suite imports THIS file to prove the client and server agree on the domain.
// Extensionless would mean re-declaring the domain in the test, which would pass
// even if the two sides drifted apart.
import { CHAIN_ID, CONTRACT_ADDRESS } from '../contract.js';

export const READ_DOMAIN = {
  name: 'ApnaRecord',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: CONTRACT_ADDRESS,
};

export const READ_TYPES = {
  RecordRead: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'viewer', type: 'address' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/**
 * Sign a read proof and return it as request headers.
 *
 * `viewer` must be the address the signer actually controls — the server recovers
 * the signer and requires the two to match, so passing someone else's address
 * produces a 401 rather than a record.
 */
export async function readProofHeaders(signer, { tokenId, viewer }) {
  const address = await signer.getAddress();
  if (address.toLowerCase() !== String(viewer).toLowerCase()) {
    throw new Error(
      `You are signed in as ${address}, so you cannot prove you are ${viewer}. ` +
        'Ask the patient to grant access to your own address.'
    );
  }

  const issuedAt = Date.now();
  const nonce = hexlify(randomBytes(32));

  const signature = await signer.signTypedData(READ_DOMAIN, READ_TYPES, {
    tokenId: Number(tokenId),
    viewer: getAddress(viewer),
    issuedAt,
    nonce,
  });

  return {
    'x-apnarecord-viewer': getAddress(viewer),
    'x-apnarecord-issued-at': String(issuedAt),
    'x-apnarecord-nonce': nonce,
    'x-apnarecord-signature': signature,
  };
}
