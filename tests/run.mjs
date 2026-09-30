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
    PORT: String(port),
    DATABASE_URL,
    SEPOLIA_RPC_URL: CHAIN,
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

const suiteEnv = { API_URL: API, API_URL_2: API_2, MOCK_LOG: chainLog, CHAIN };
await runSuite('Unit — email addresses, codes, relay adapters', 'unit/email.test.mjs', {});
await runSuite('Integration — email verification over HTTP', 'integration/contact.test.mjs', suiteEnv);
await runSuite('Integration — wallet enrolment and funding', 'integration/wallet.test.mjs', suiteEnv);
await runSuite('Integration — binding: one contact, one wallet', 'integration/binding.test.mjs', suiteEnv);
await runSuite('Integration — hardening: signatures, limits, CORS', 'integration/hardening.test.mjs', suiteEnv);
await runSuite('Integration — the dripper across two instances', 'integration/dripper.test.mjs', suiteEnv);

killAll();

if (exitCode !== 0) {
  console.log(`\nChain output:\n${tail(chainLog, 30)}\n`);
  console.log(`Server output:\n${tail(serverLog, 30)}\n`);
} else {
  console.log('\nAll suites passed.\n');
}

process.exit(exitCode);
