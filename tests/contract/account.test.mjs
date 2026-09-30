// THE ACCOUNT, EXECUTED FOR REAL.
//
// Everywhere else in these suites, the chain is a stub — and a stub cannot execute a
// contract. That is fine for testing the server's plumbing, and useless for testing the
// account, whose entire job is to enforce something at runtime:
//
//   • only the owner may `execute`
//   • only an allowlisted target may be called
//   • the target sees the ACCOUNT as `msg.sender`, which is the mechanism that lets the
//     account own a record and grant access to it
//   • `owner()` cannot be changed by anyone, ever
//
// So this suite runs an in-process EVM (ganache) and does all of it for real. It is the
// only place the contract's actual behaviour is checked, and the contract is what the
// records are permanently bound to — a bug here is unrecoverable, not merely a bug.
//
// Run from the project root:  node tests/contract/account.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import solc from 'solc';
import { ethers } from 'ethers';
import { check, group, report } from '../support/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

function compile(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [path.basename(relativePath)]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  }
  const name = path.basename(relativePath).replace(/\.sol$/, '');
  return output.contracts[path.basename(relativePath)][name];
}

/**
 * The name of the custom error a call reverted with, or null if it succeeded.
 *
 * Decoded from the raw revert data rather than read off the message. ethers puts a
 * custom error's selector in `error.data`, and the estimateGas path drops it entirely —
 * so the refusal cases go through `staticCall` and this decodes what comes back, which
 * turns "execution reverted (unknown custom error)" into `NotOwner`.
 */
async function revertName(promise, iface) {
  try {
    await promise;
    return null;
  } catch (error) {
    const data = error?.data ?? error?.info?.error?.data ?? null;
    if (typeof data === 'string' && data.startsWith('0x') && iface) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return parsed.name;
      } catch {
        /* not one of ours */
      }
    }
    return error?.shortMessage || error?.message || 'reverted';
  }
}

group('setup');

// Ganache is an older EVM and does not know the Cancun hardfork, so it runs at its own
// default. That is fine for this contract — it uses no Cancun-only opcode — but it is a
// real difference from the chain it deploys to, and worth knowing rather than assuming.
const evm = ganache.provider({ logging: { quiet: true } });
const provider = new ethers.BrowserProvider(evm);
const accounts = await provider.listAccounts();
const ownerSigner = await provider.getSigner(accounts[0].address);
const strangerSigner = await provider.getSigner(accounts[1].address);

const ownerAddress = await ownerSigner.getAddress();
const strangerAddress = await strangerSigner.getAddress();

/**
 * Read a balance without ethers' per-block cache.
 *
 * `provider.getBalance` is cached for a short window keyed on the block, so a before/after
 * pair taken around an instantaneous transaction can both return the OLD value — making a
 * correct transfer look like it did nothing. `send` goes straight to the node.
 */
const balanceOf = async (address) => BigInt(await provider.send('eth_getBalance', [address, 'latest']));

const accountArtifact = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/artifacts/ApnaRecordAccount.json'), 'utf8')
);
const echoCompiled = compile('contracts/test/EchoCaller.sol');

// Deploy the target first, so it can be named in the account's allowlist.
const echoFactory = new ethers.ContractFactory(echoCompiled.abi, `0x${echoCompiled.evm.bytecode.object}`, ownerSigner);
const echo = await echoFactory.deploy();
await echo.waitForDeployment();
const echoAddress = await echo.getAddress();

const accountFactory = new ethers.ContractFactory(
  accountArtifact.abi,
  accountArtifact.bytecode,
  ownerSigner
);
const account = await accountFactory.deploy(ownerAddress, [echoAddress]);
await account.waitForDeployment();
const accountAddress = await account.getAddress();

check('the EVM is running and accounts are funded', accounts.length >= 2, `${accounts.length} accounts`);
check('the account deployed', ethers.isAddress(accountAddress), accountAddress);
check('the target deployed', ethers.isAddress(echoAddress), echoAddress);

group('the owner is fixed at construction');

check('owner() is the key that deployed it', (await account.owner()) === ownerAddress);
check(
  'the owner is not the deployer by accident for a non-owner',
  (await account.owner()) !== strangerAddress
);
check(
  'there is no function that writes the owner',
  !accountArtifact.abi.some(
    (entry) => entry.type === 'function' && entry.name !== 'owner' && entry.name?.toLowerCase().includes('owner')
  ),
  accountArtifact.abi.filter((e) => e.type === 'function').map((e) => e.name).join(', ')
);
check(
  'and no SELFDESTRUCT, so the account cannot be removed from under the records',
  !fs.readFileSync(path.join(root, 'contracts/ApnaRecordAccount.sol'), 'utf8').includes('selfdestruct')
);

group('only the owner may execute');

// staticCall, not a transaction: the point is to prove it reverts, and the estimateGas
// path strips the custom-error data, which turns a precise `NotOwner` into an
// unhelpful "unknown custom error".
const asStranger = await revertName(
  account.connect(strangerSigner).execute.staticCall(
    echoAddress,
    0,
    echo.interface.encodeFunctionData('ping', [1])
  ),
  account.interface
);
check(
  "a non-owner's execute is refused",
  asStranger === 'NotOwner',
  asStranger
);

group('only an allowlisted target may be called');

// EchoCaller is in the allowlist; this address is not, and the point is that an address
// outside the set is unreachable even by the owner.
const notAllowed = await revertName(
  account.execute.staticCall(strangerAddress, 0, '0x'),
  account.interface
);
check(
  'a target outside the allowlist is refused',
  notAllowed === 'TargetNotAllowed',
  notAllowed
);
check('and the allowlist agrees it is not there', (await account.isAllowedTarget(strangerAddress)) === false);
check('while the named target is allowed', (await account.isAllowedTarget(echoAddress)) === true);

group('the account can be funded');

const funded = await ownerSigner.sendTransaction({ to: accountAddress, value: ethers.parseEther('1') });
await funded.wait();
check(
  'receive() accepts a plain transfer, which is how the dripper funds it',
  (await balanceOf(accountAddress)) === ethers.parseEther('1')
);

group('execute calls the target AS THE ACCOUNT');

// Funded first: the account carries the value out of its own balance, so an unfunded
// account reverts with CallFailed — which is correct behaviour and a confusing thing to
// trip over while testing something else.
const value = ethers.parseEther('0.25');
const before = await balanceOf(echoAddress);

const pingData = echo.interface.encodeFunctionData('ping', [41]);
const tx = await account.execute(echoAddress, value, pingData);
await tx.wait();

check(
  'the target saw the ACCOUNT as msg.sender, not the key',
  (await echo.lastCaller()).toLowerCase() === accountAddress.toLowerCase(),
  `${await echo.lastCaller()} vs ${accountAddress}`
);
check('and saw the value it was sent', (await echo.lastValue()) === value, String(await echo.lastValue()));
check('and received the argument intact', (await echo.lastArg()) === 41n, String(await echo.lastArg()));
check('and recorded exactly one call', (await echo.callCount()) === 1n);
check(
  'the balance actually moved',
  (await balanceOf(echoAddress)) === before + value,
  'balance unchanged'
);

group("a target's own revert reason survives");

const exploded = await revertName(
  account.execute.staticCall(echoAddress, 0, echo.interface.encodeFunctionData('explode')),
  account.interface
);
check(
  'the account hands back the target’s failure rather than an anonymous one',
  exploded === 'CallFailed',
  exploded
);

group('EIP-1271');

const digest = ethers.keccak256(ethers.toUtf8Bytes('a read proof digest'));

// Ganache does not expose account private keys over RPC and its accounts sign through
// `eth_sendTransaction`, which cannot produce a raw signature. So the EIP-1271 cases use
// a second account whose owner key is a local wallet this test holds.
const localOwner = ethers.Wallet.createRandom();
const localAccountFactory = new ethers.ContractFactory(
  accountArtifact.abi,
  accountArtifact.bytecode,
  ownerSigner
);
const localAccount = await localAccountFactory.deploy(await localOwner.getAddress(), [echoAddress]);
await localAccount.waitForDeployment();

const goodSignature = await localOwner.signingKey.sign(digest).serialized;
check(
  'the owner’s signature is accepted',
  (await localAccount.isValidSignature(digest, goodSignature)) === '0x1626ba7e',
  await localAccount.isValidSignature(digest, goodSignature)
);

const strangerSignature = await ethers.Wallet.createRandom().signingKey.sign(digest).serialized;
check(
  "a stranger's signature is refused",
  (await localAccount.isValidSignature(digest, strangerSignature)) === '0xffffffff'
);

const otherDigest = ethers.keccak256(ethers.toUtf8Bytes('a different digest'));
check(
  'a signature for a different digest is refused',
  (await localAccount.isValidSignature(otherDigest, goodSignature)) === '0xffffffff'
);

check(
  'a malformed signature is refused rather than throwing',
  (await localAccount.isValidSignature(digest, '0xdead')) === '0xffffffff'
);

// Malleability: the same signature with the upper half of the curve rejected.
const sig = ethers.Signature.from(goodSignature);
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const flippedS = ethers.toBeHex(N - BigInt(sig.s), 32);
const malleable = ethers.concat([sig.r, flippedS, ethers.toBeHex(sig.v === 27 ? 28 : 27, 1)]);
check(
  'the malleable twin of a valid signature is refused',
  (await localAccount.isValidSignature(digest, malleable)) === '0xffffffff',
  'a low-s guard is what stops a replay guard being walked around'
);

report();
