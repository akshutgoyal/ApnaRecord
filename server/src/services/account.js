// THE PATIENT'S ACCOUNT — deployment, and reading who owns one.
//
// The account is what permanently owns a patient's records, so its address is the
// identity everything else refers to. The server deploys it because an account cannot
// pay for its own creation, and the gas float already exists to pay for exactly this
// kind of thing.
//
// WHAT THE SERVER CANNOT DO, which is the point of the arrangement:
//
//   It deploys an account owned by the user's key. It cannot deploy one owned by
//   itself and pass it off — and it does not have to be trusted not to, because the
//   CREATE address is derived from the deployer's nonce and the client reads `owner()`
//   back and refuses unless it matches its own key.
//
// The artifact is committed and read from disk. Deployment must never require a
// Solidity compiler at runtime, and a committed artifact is what lets the deployed
// bytecode be compared against the source it came from.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { getProvider } from './chain.js';
import { deployContract } from './dripper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactPath = path.resolve(
  here,
  '../../../contracts/artifacts/ApnaRecordAccount.json'
);

/**
 * The artifact is loaded lazily, and only for deployment.
 *
 * Reading `owner()` must not depend on a build output existing: the read path runs on
 * every consented record fetch, and a missing artifact there would take down reading
 * for everyone instead of failing the one operation that actually needs it.
 */
function loadArtifact() {
  try {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read the account artifact at ${artifactPath}. Run ` +
        `\`npm run compile:contracts\` — the account cannot be deployed without it. ` +
        `(${error.message})`
    );
  }
}

/**
 * Just the read. Declared here rather than taken from the artifact so it is available
 * without a build step.
 */
export const ACCOUNT_READ_ABI = ['function owner() view returns (address)'];

const readInterface = new ethers.Interface(ACCOUNT_READ_ABI);

/**
 * Deploy an account owned by `owner`, able to call only `allowedTargets`.
 *
 * Waits for the receipt, because the address is the result: there is nothing to hand
 * back until the chain has produced one.
 */
export async function deployAccount({ owner, allowedTargets }) {
  if (!Array.isArray(allowedTargets) || allowedTargets.length === 0) {
    // An account with no callable target can do nothing at all. That is not a
    // configuration to discover later, when a patient's first grant mysteriously
    // reverts.
    throw new Error('An account needs at least one allowed target.');
  }

  const artifact = loadArtifact();

  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address[]'],
    [ethers.getAddress(owner), allowedTargets.map((target) => ethers.getAddress(target))]
  );

  const data = ethers.concat([artifact.bytecode, constructorArgs]);
  return deployContract(data);
}

/**
 * Who owns this account address, or null when the address is not an account at all.
 *
 * Returns null rather than throwing for a plain EOA. The demo personas are EOAs whose
 * records still exist and must stay readable, so "this is not one of our accounts" is
 * an ordinary answer here rather than an error — and the caller checks `owner()`
 * against the signature it already recovered.
 */
export async function accountOwner(address) {
  if (!ethers.isAddress(address)) return null;

  try {
    const result = await getProvider().call({
      to: ethers.getAddress(address),
      data: readInterface.encodeFunctionData('owner'),
    });
    const [owner] = readInterface.decodeFunctionResult('owner', result);
    return owner;
  } catch {
    // No such function, or no code at the address. Either way it is not an account.
    return null;
  }
}
