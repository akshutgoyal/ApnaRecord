// Runs the integration suites end to end.
//
//   node tests/run.mjs          (or: npm run test:integration)
//
// It starts a stub chain and a real server, runs both HTTP suites against them, and
// tears everything down — including on failure, so a red run does not leave a server
// holding port 5000.
//
// WHAT IT NEEDS FROM THE ENVIRONMENT: a MongoDB it can reach. That is the only external
// dependency, because codes and grants are stored there. Everything else — the chain, the
// mail relay — is stubbed here.
//
//   MongoDB at 127.0.0.1:27017     docker run -d -p 27017:27017 mongo:7
//   or set DATABASE_URL to point elsewhere.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, createWriteStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const API_PORT = Number(process.env.API_PORT) || 5000;
const CHAIN_PORT = Number(process.env.CHAIN_PORT) || 8545;
const API = `http://127.0.0.1:${API_PORT}/api`;
const CHAIN = `http://127.0.0.1:${CHAIN_PORT}`;
// A SECOND server instance, deliberately. The dripper's nonce claim used to be a
// promise chain, which only orders sends inside one process — so the bug it was
// written to prevent (two instances handing out the same nonce) could not be tested
// from a single server. Two processes on one database is the configuration that
// exposes it.
const API_PORT_2 = Number(process.env.API_PORT_2) || API_PORT + 1;
const API_2 = `http://127.0.0.1:${API_PORT_2}/api`;
const DATABASE_URL = process.env.DATABASE_URL || 'mongodb://127.0.0.1:27017/apnarecord_test';

const scratch = mkdtempSync(path.join(tmpdir(), 'apnarecord-tests-'));
const chainLog = path.join(scratch, 'chain.log');
const serverLog = path.join(scratch, 'server.log');
const serverLog2 = path.join(scratch, 'server2.log');

const children = [];
let exitCode = 0;

function killAll() {
  for (const child of children) {
    if (!child.killed) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
  }
}
process.on('exit', killAll);
process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});

/** Refuse to start on a port something else owns, rather than testing a stranger's server. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

function start(name, command, args, env, logPath) {
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`  [${name}] exited with code ${code}`);
  });
  children.push(child);
  return child;
}

async function waitFor(label, url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} never became reachable at ${url}`);
}

function runSuite(label, file, env) {
  return new Promise((resolve) => {
    console.log(`\n${'─'.repeat(70)}\n${label}\n${'─'.repeat(70)}`);
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      cwd: ROOT,
      // A suite imports server modules, which now validate configuration on load.
      // Pinning NODE_ENV after the ambient environment keeps a stray NODE_ENV
      // exported in the developer's shell from turning the production requirements
      // on and failing every run.
      env: { ...process.env, NODE_ENV: 'test', ...env },
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code !== 0) exitCode = 1;
      resolve(code);
    });
  });
}

function tail(file, lines = 25) {
  try {
    const text = readFileSync(file, 'utf8').trim().split('\n');
    return text.slice(-lines).join('\n');
  } catch {
    return '(no output)';
  }
}

// ----------------------------------------------------------------- start

for (const port of [API_PORT, API_PORT_2, CHAIN_PORT]) {
  if (!(await portIsFree(port))) {
    console.error(
      `\nPort ${port} is already in use. Stop whatever is holding it, or set ` +
        `API_PORT / CHAIN_PORT to free ports.\n` +
        `  lsof -i :${port}\n`
    );
    process.exit(1);
  }
}

// A fresh dripper per run, so a stray balance can never make an assertion pass.
const dripper = Wallet.createRandom();
console.log(`\nStarting the stub chain on ${CHAIN} and the server on ${API}`);
console.log(`Database: ${DATABASE_URL}`);
console.log(`Dripper (throwaway): ${dripper.address}`);

// Drop the test database before anything starts.
//
// Without this a run inherits whatever the last one left behind, and the suite passes
// until accumulated state trips an assertion. That is exactly what happened: the
// dripper's daily cap quietly filled up across successive runs, and then every
// enrolment's drip began being skipped — turning "is funded" red for a reason that run
// had not caused. A suite whose result depends on how many times it has been run is not
// telling you anything.
//
// Guarded twice, and the second guard is the one that matters.
//
// "Is it localhost?" is not the question. It permits dropping any database on your own
// machine, and DATABASE_URL is exactly the variable someone points at their dev data —
// pointing it at a working directory and running the suite would delete it silently.
// The NAME is what should carry the permission: only a database that calls itself a test
// one is dropped. The worst case then is a test database that did not need clearing,
// rather than an evening's labelling.
const dbName = (DATABASE_URL.match(/\/([^/?]+)(\?|$)/) || [])[1] || '';
const isLocal = /127\.0\.0\.1|localhost/.test(DATABASE_URL);
const mayDrop = isLocal && /test/i.test(dbName);

// Refuse to run at all against a remote database.
//
// The guard below stops the suite DROPPING one, which is the destructive half. It does not
// stop it WRITING to one -- and it writes enrolments, identities and drip records, every
// run. Pointed at Atlas it filled a real admin panel with fifteen wallets that look like
// registrations and belong to nobody, and the only way to tell was that none carried a
// role. A destructive guard on the drop was never the whole risk.
//
// Overridable, because CI legitimately runs against a throwaway remote instance and should
// say so on purpose rather than by accident.
if (!isLocal && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
  console.error(
    `\nRefusing to run: DATABASE_URL points at "${dbName}", which is not localhost.\n` +
      'This suite WRITES enrolments and drip records, so a remote run leaves them behind.\n' +
      'Set ALLOW_REMOTE_TEST_DB=1 if you meant it, and point it at a database you can throw away.\n'
  );
  process.exit(1);
}

if (mayDrop) {
  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(DATABASE_URL, { serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`Dropped the test database (${dbName}).`);
} else {
  // Loud, because silently not clearing is how you get a suite that fails for a reason
  // the last run caused — the bug this whole block exists to prevent.
  console.log(
    `Not dropping "${dbName}" — the name does not say "test", so this run inherits its state.`
  );
}

start(
  'chain',
  process.execPath,
  [path.join(HERE, 'support', 'mock-chain.mjs')],
  { MOCK_PORT: String(CHAIN_PORT), MOCK_DRIPPER: dripper.address, MOCK_FLOAT: '10' },
  chainLog
);

await waitFor('the stub chain', CHAIN, 20);

/** The environment both server instances share. */
function serverEnv(port) {
  return {
    // Pinned rather than inherited. The ambient shell may have NODE_ENV=production,
    // which turns on the production configuration requirements — a test run should
    // not depend on what happened to be exported in the terminal that launched it.
    NODE_ENV: 'test',
    EMAIL_PROVIDER: 'mock',
    MASTER_KEY: 'a'.repeat(64),
    UPLOAD_DIR: path.join(scratch, 'uploads'),
    // Same reasoning as the email mock and the database name: a suite that
    // inherits the developer's storage writes test blobs into the real bucket.
    S3_BUCKET: '',
    PORT: String(port),
    DATABASE_URL,
    RPC_URL: CHAIN,
    // Must match what tests/support/mock-chain.mjs reports for eth_chainId. It is
    // bound into the EIP-712 read domain, so a disagreement here would reject every
    // signed read — the same failure the production server now checks for at boot.
    CHAIN_ID: '84532',
    // Pinned, not inherited. The contract address is read with `eth_getCode` and
    // `eth_call`, both of which the stub chain answers for ANY address — so the
    // suites do not care what it is. What they must not do is depend on whatever
    // happened to be in the developer's server/.env, which is exactly what they did
    // until a migration blanked it and thirteen assertions went red for a reason
    // that had nothing to do with the change.
    CONTRACT_ADDRESS: '0x0000000000000000000000000000000000000abc',
    DRIPPER_PRIVATE_KEY: dripper.privateKey,
    // The suites call the API from Node, which sends no Origin header, so the
    // allowlist does not obstruct them. Listing an origin exercises the real path.
    CORS_ORIGINS: 'http://localhost:5173',
    // A test has to be able to request two codes for one address; production keeps
    // the defaults and does not set these.
    CONTACT_RESEND_COOLDOWN_MS: '2000',
    CONTACT_MAX_PER_IP: '500',
  };
}

start(
  'server',
  process.execPath,
  [`${path.join('server', 'src', 'index.js')}`],
  serverEnv(API_PORT),
  serverLog
);

start(
  'server-2',
  process.execPath,
  [`${path.join('server', 'src', 'index.js')}`],
  serverEnv(API_PORT_2),
  serverLog2
);

try {
  await waitFor('the server', `${API}/health`);
  await waitFor('the second server', `${API_2}/health`);
} catch (error) {
  console.error(`\n${error.message}\n`);
  console.error(`Server output:\n${tail(serverLog)}\n`);
  console.error(
    'The usual cause is MongoDB not being reachable. Codes and grants are stored there, ' +
      'so the verification suites cannot run without it.'
  );
  killAll();
  process.exit(1);
}

// ----------------------------------------------------------------- suites

// The suite signs read proofs, and the domain it signs against has to be the one the
// server verifies with. Both sides read CONTRACT_ADDRESS and CHAIN_ID, so leaving them
// out here meant the suite signed against a domain with no verifyingContract and every
// proof was rejected as though it had been forged — which is exactly the failure
// readProof.js warns about, presenting as a permissions bug rather than a config one.
// Pinned to the same stub values serverEnv() uses.
const suiteEnv = {
  API_URL: API,
  API_URL_2: API_2,
  MOCK_LOG: chainLog,
  CHAIN,
  CONTRACT_ADDRESS: '0x0000000000000000000000000000000000000abc',
  CHAIN_ID: '84532',
};
// The contract suite runs first and on its own EVM. It needs no server, no database and
// no stub chain — it is the only suite that executes a contract rather than pretending
// to, and it is where the account's behaviour is actually established.
await runSuite('Contract — the account, executed on a real EVM', 'contract/account.test.mjs', {});
await runSuite('Contract — ApnaRecord, executed on a real EVM', 'contract/apnarecord.test.mjs', {});
await runSuite('Unit — email addresses, codes, relay adapters', 'unit/email.test.mjs', {});
await runSuite('Unit — directory wire formats', 'unit/directory.test.mjs', {});
await runSuite('Unit — the indexer link fold', 'unit/indexer.test.mjs', {});
await runSuite('Integration — email verification over HTTP', 'integration/contact.test.mjs', suiteEnv);
await runSuite('Integration — wallet enrolment and funding', 'integration/wallet.test.mjs', suiteEnv);
await runSuite('Integration — binding: one contact, one wallet', 'integration/binding.test.mjs', suiteEnv);
await runSuite('Integration — hardening: signatures, limits, CORS', 'integration/hardening.test.mjs', suiteEnv);
await runSuite('Integration — directory: signed metadata, scoped reads', 'integration/directory.test.mjs', suiteEnv);
await runSuite('Integration — the dripper across two instances', 'integration/dripper.test.mjs', suiteEnv);

killAll();

if (exitCode !== 0) {
  console.log(`\nChain output:\n${tail(chainLog, 30)}\n`);
  console.log(`Server output:\n${tail(serverLog, 30)}\n`);
} else {
  console.log('\nAll suites passed.\n');
}

process.exit(exitCode);
