// END-TO-END PROOF, AGAINST REAL BASE SEPOLIA.
//
// Deliberately NOT part of `npm test`: it spends real testnet funds, deploys a real
// contract and leaves both behind. Run it after anything that touches enrolment, the
// account, the drip or the write path — it is the only thing here that exercises those
// against a live chain rather than a stub.
//
//   NODE_ENV=development DATABASE_URL=mongodb://127.0.0.1:27017/apnarecord_proof \
//     node tests/manual/base-proof.mjs
//
// It needs a running API whose DRIPPER_PRIVATE_KEY is funded. Each run costs the float
// about 0.0104 ETH (the owner-key drip plus the account deployment).

import { Wallet, JsonRpcProvider, Contract, Interface } from 'ethers';
import {
  createWallet,
  sealPrivateKey,
  generateRecoveryCode,
} from '../../client/src/lib/keystore.js';
import { enrolMessage } from '../../client/src/lib/wireMessages.js';
import { ABI, ACCOUNT_ABI, CONTRACT_ADDRESS, TX_EXPLORER } from '../../client/src/contract.js';

const API = 'http://localhost:5000/api';
const RPC = 'https://sepolia.base.org';
const provider = new JsonRpcProvider(RPC);

const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const step = (n, text) => console.log(`\n[${n}] ${text}`);
let failures = 0;
const ok = (label, condition, detail = '') => {
  console.log(`   ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`);
  if (!condition) failures += 1;
};

const email = `base-proof-${Date.now()}@example.com`;
console.log(`Proof run against ${RPC}`);
console.log(`contract ${CONTRACT_ADDRESS}`);
console.log(`test identity ${email}`);

// ---------------------------------------------------------------- 1. the contact
step(1, 'verify an email address (mock sender, so no real mailbox is involved)');
const requested = await post('/identity/email/request', { email });
ok('the code was issued', requested.status === 200, `status ${requested.status}`);
const verified = await post('/identity/email/verify', {
  email,
  code: requested.body.devCode,
});
ok('the address verified and returned a single-use grant', verified.status === 200 && !!verified.body.token);
const grantToken = verified.body.token;
ok('the grant says what it cannot do', String(verified.body.note || '').length > 0);

// ---------------------------------------------------------------- 2. keys, locally
step(2, 'generate a wallet here and seal it, as the browser does');
const { address, privateKey } = createWallet();
const recoveryCode = generateRecoveryCode();
const sealed = await sealPrivateKey(privateKey, recoveryCode);
const timestamp = Date.now();
const signature = await new Wallet(privateKey).signMessage(enrolMessage(address, timestamp));
console.log(`   signing key   ${address}`);

// ---------------------------------------------------------------- 3. enrolment
step(3, 'enrol — this deploys the account and drips 0.01 ETH to its owner key');
const enrolled = await post('/wallet/enrol', {
  address,
  // Sent, not omitted. This suite used to enrol without a role, so every row it
  // created looked like a registration whose selector had failed -- and the role path
  // had no test at all. A caller that skips the input proves nothing about the feature
  // that consumes it.
  requestedRole: 'patient',
  sealed: sealed.sealed,
  salt: sealed.salt,
  iterations: sealed.iterations,
  grantToken,
  timestamp,
  signature,
});
ok('enrolment accepted', enrolled.status === 201, `status ${enrolled.status} ${JSON.stringify(enrolled.body).slice(0, 220)}`);

const account = enrolled.body.address;
const deployTx = enrolled.body.accountTxHash;
const drip = enrolled.body.drip || {};
console.log(`   account       ${account}`);
console.log(`   deploy tx     ${deployTx || '(none)'}`);
console.log(`   drip          ${drip.txHash ? drip.txHash + ' · ' + (drip.amountEth ?? '?') + ' ETH' : JSON.stringify(drip)}`);
ok('an account address came back', Boolean(account));
ok('the account deployment broadcast', Boolean(deployTx));
ok('the drip broadcast', Boolean(drip.txHash));

// ---------------------------------------------------------------- 4. on-chain truth
step(4, 'verify on Base Sepolia what the server claimed');
if (account) {
  let code = '0x';
  for (let i = 0; i < 20; i += 1) {
    code = await provider.getCode(account);
    if (code !== '0x') break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  ok('the account is a deployed contract on Base Sepolia', code !== '0x', `${(code.length - 2) / 2} bytes`);

  const vault = new Contract(account, ACCOUNT_ABI, provider);
  const owner = await vault.owner();
  ok('its owner is the signing key, not the server', owner.toLowerCase() === address.toLowerCase(), owner);
  ok('ApnaRecord is an allowed target', await vault.isAllowedTarget(CONTRACT_ADDRESS));

  // THE DRIP IS FIRE-AND-FORGET. The server deliberately does not wait for it, so reading
  // the chain a second after the response says nothing. Wait for it instead — this is the
  // same thing the browser has to do, and the reason `ensureGas` exists.
  let balance = 0n;
  for (let i = 0; i < 40; i += 1) {
    balance = await provider.getBalance(owner);
    if (balance > 0n) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  ok('the owner key holds the gas for account.execute', balance > 0n, `${Number(balance) / 1e18} ETH`);

  const waitReceipt = async (hash) => {
    for (let i = 0; i < 40; i += 1) {
      const r = await provider.getTransactionReceipt(hash);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 3000));
    }
    return null;
  };

  if (deployTx) {
    const receipt = await waitReceipt(deployTx);
    ok('the deploy transaction is mined', receipt?.status === 1, `block ${receipt?.blockNumber}`);
  }
  if (drip.txHash) {
    const receipt = await waitReceipt(drip.txHash);
    ok('the drip transaction is mined', receipt?.status === 1, `block ${receipt?.blockNumber}`);
  }

  // -------------------------------------------------------------- 5. a real write
  step(5, 'write THROUGH the account — the path every action in the UI takes');
  const signer = new Wallet(privateKey, provider);
  const vaultAsOwner = new Contract(account, ACCOUNT_ABI, signer);
  const apna = new Interface(ABI);
  const data = apna.encodeFunctionData('grantAccess', [
    1,
    '0x000000000000000000000000000000000000dEaD',
    3600,
  ]);
  try {
    const tx = await vaultAsOwner.execute(CONTRACT_ADDRESS, 0, data);
    const receipt = await tx.wait();
    ok('the account reached ApnaRecord and the call succeeded', receipt?.status === 1);
    console.log(`   ${TX_EXPLORER}${tx.hash}`);
  } catch (error) {
    // WHICH contract refused is the whole question, so decode it rather than matching on
    // a message. `CallFailed` means the account's own checks — onlyOwner and the target
    // allowlist — both PASSED, the call to ApnaRecord was made, and ApnaRecord refused.
    // `NotOwner` or `TargetNotAllowed` would mean the account itself never got that far,
    // which is a different failure entirely. Matching on shortMessage cannot tell these
    // apart: ethers reports all three as "unknown custom error".
    const raw = error?.data || error?.info?.error?.data || null;
    let name = null;
    if (raw) {
      try {
        name = new Interface(ACCOUNT_ABI).parseError(raw)?.name || null;
      } catch {
        name = null;
      }
    }
    ok(
      'execute() passed the account\'s own checks and reached ApnaRecord',
      name === 'CallFailed',
      name === 'CallFailed'
        ? 'CallFailed — the contract refused a call the account was permitted to make'
        : `revert was ${name || 'undecodable'}: ${(error?.shortMessage || String(error)).slice(0, 140)}`
    );
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
