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

import { Contract, getAddress, hexlify, randomBytes } from 'ethers';
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
 * `viewer` is the address whose access the contract will judge. Usually that is the
 * signer, but for a record owned by an account it is the ACCOUNT and the signature
 * comes from the key that owns it — a contract cannot sign, so an account could
 * otherwise never read its own records, which is every record created since enrolment
 * started deploying one. The server accepts exactly that pair.
 *
 * This pre-check exists only to turn a confusing 401 into a clear sentence, so it must
 * stay no stricter than the server. It was stricter once, and it rejected the account
 * case before a signature was ever produced: every enrolled patient was unable to open
 * their own record, with an error telling them to ask themselves for access.
 */
export async function readProofHeaders(signer, { tokenId, viewer }) {
  const address = await signer.getAddress();

  if (address.toLowerCase() !== String(viewer).toLowerCase()) {
    const account = new Contract(viewer, ['function owner() view returns (address)'], signer.provider);
    const owner = await account.owner().catch(() => null);

    if (!owner || owner.toLowerCase() !== address.toLowerCase()) {
      throw new Error(
        `You are signed in as ${address}, so you cannot prove you are ${viewer}. ` +
          'Ask the patient to grant access to your own address.'
      );
    }
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
