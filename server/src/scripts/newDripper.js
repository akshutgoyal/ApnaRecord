// Generate the wallet that funds everyone else.
//
// Run this once, paste the key into server/.env, then fund the address from a
// faucet. Nothing in this codebase can acquire Sepolia ETH for you — every faucet
// is rate-limited against exactly the use this wallet exists for, so the funding
// step is manual by nature rather than by omission.

import { Wallet, randomBytes, hexlify } from 'ethers';

const wallet = new Wallet(hexlify(randomBytes(32)));

console.log('');
console.log('  A new gas float. Put the key in server/.env as DRIPPER_PRIVATE_KEY.');
console.log('');
console.log(`  address      ${wallet.address}`);
console.log(`  private key  ${wallet.privateKey}`);
console.log('');
console.log('  Next: send test ETH to the address above, then restart the API.');
console.log('  A practical route (see README for the full comparison):');
console.log('    https://sepolia-faucet.pk910.de/   — no account, ~20 min of mining per claim');
console.log('');
console.log('  Sizing: at DRIP_AMOUNT=0.01, each ETH covers about 100 new wallets.');
console.log('  Check what is left at any time with:  curl localhost:5000/api/dripper');
console.log('');
console.log('  Do not reuse this key on any network where the balance has value.');
console.log('');
