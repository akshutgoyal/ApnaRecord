// Generate the wallet that funds everyone else.
//
// Run this once, paste the key into server/.env, then fund the address by hand.
// Nothing in this codebase acquires Sepolia ETH for you, and that is deliberate:
// replenishing automatically would mean mining proof-of-work on the application
// server to satisfy a faucet. The float costs nothing to top up manually.

import { Wallet, randomBytes, hexlify } from 'ethers';

const wallet = new Wallet(hexlify(randomBytes(32)));

console.log('');
console.log('  A new gas float. Put the key in server/.env as DRIPPER_PRIVATE_KEY.');
console.log('');
console.log(`  address      ${wallet.address}`);
console.log(`  private key  ${wallet.privateKey}`);
console.log('');
console.log('  Next: fund the address above by hand, then restart the API.');
console.log('  There is no automatic replenishment by design — it would mean mining');
console.log('  proof-of-work on the application server to satisfy a faucet.');
console.log('');
console.log('  Sizing: at DRIP_AMOUNT=0.01, each ETH covers about 100 new wallets.');
console.log('  Check what is left at any time with:  curl localhost:5000/api/dripper');
console.log('');
console.log('  Do not reuse this key on any network where the balance has value.');
console.log('');
