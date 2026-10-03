// A tiny assertion harness, shared by the suites.
//
// Deliberately not a framework. The suites are run directly with `node` so they work in
// a fresh clone with no test dependency to install, and so a failure can be read without
// a reporter getting between you and the message.
//
// Every assertion takes a `detail` argument, and every caller is expected to pass the
// value it actually saw. A bare "expected true" tells you nothing at 2am.

const results = { passed: 0, failed: 0 };
let section = '';

/**
 * Headers proving a wallet, for the read endpoints that require one.
 *
 * Off-chain rows — labels, facility names, the record index, the clinical profile — are
 * no longer served to anonymous callers, so a suite that reads them has to say who it
 * is. There is no session in a test, so this is the raw proof: the same EIP-712
 * statement the record release uses, with tokenId 0 meaning "not about a record".
 *
 * A fresh nonce every call. The server spends it against a unique index, so a reused
 * proof is refused — that is the replay guard working, and a suite that cached one would
 * be testing the refusal rather than the endpoint.
 *
 * The domain comes from the server's own module rather than being re-declared here, so
 * the two sides cannot drift apart in a way that would pass while the deployment failed.
 */
let proofWallet = null;

export async function proofHeaders() {
  const { Wallet, getAddress, hexlify, randomBytes } = await import('ethers');
  const { READ_DOMAIN, READ_TYPES } = await import('../../server/src/lib/readProof.js');

  if (!proofWallet) proofWallet = Wallet.createRandom();
  const viewer = getAddress(proofWallet.address);
  const issuedAt = Date.now();
  const nonce = hexlify(randomBytes(32));
  const signature = await proofWallet.signTypedData(READ_DOMAIN(), READ_TYPES, {
    tokenId: 0,
    viewer,
    issuedAt,
    nonce,
  });

  return {
    'x-apnarecord-viewer': viewer,
    'x-apnarecord-issued-at': String(issuedAt),
    'x-apnarecord-nonce': nonce,
    'x-apnarecord-signature': signature,
  };
}

export function group(name) {
  section = name;
  console.log(`\n${name}`);
}

export function check(name, condition, detail = '') {
  if (condition) {
    results.passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    results.failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Assert that `fn` throws, and hand back the error so its message can be inspected. */
export function caught(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

export function report() {
  const { passed, failed } = results;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0 && section) console.log(`(last section: ${section})`);
  process.exit(failed === 0 ? 0 : 1);
}
