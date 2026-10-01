// Environment loading, done once and done first.
//
// This module exists because of an ordering trap that is easy to miss and produces
// a genuinely confusing class of bug. ES module imports are evaluated depth-first
// BEFORE the importing module's own body runs, so a `dotenv.config()` sitting in
// index.js executes *after* every module it imports has already been evaluated.
// Any module that reads process.env at its top level therefore saw `undefined` and
// silently fell back to its default — a configured DRIP_AMOUNT of 0.05 would be
// quietly ignored and 0.01 sent instead.
//
// Two things fix it:
//
//   1. This module is imported FIRST in every entry point, so its side effect lands
//      before anything else is evaluated.
//   2. The path is resolved from this file, not from the working directory. Running
//      `node server/src/index.js` from the repo root used to load no configuration
//      at all, because dotenv looked for a .env beside the cwd that was never there.
//
// `override: false` is the default and is what we want: an explicit shell variable
// still wins over the file, which is what makes one-off overrides in tests work.

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(here, '../../.env');

const result = dotenv.config({ path: envPath });

export const envFile = envPath;
export const envLoaded = !result.error;

if (result.error && process.env.NODE_ENV !== 'production') {
  // A missing .env is normal on a host that injects configuration, so this is a
  // note rather than a failure.
  console.warn(`[Env] No .env at ${envPath} — relying on the process environment.`);
}

// ---------------------------------------------------------------- validation
//
// WHY THIS IS HERE AND NOT IN EACH CONSUMER.
//
// Every one of these values used to be checked at the moment it was first needed,
// which meant a malformed MASTER_KEY produced a server that booted cleanly, served
// /health, and then failed the first request that touched a sealed key — with an
// error that pointed at the record rather than at the configuration. The same was
// true of the dripper key: enrolment succeeded and only the drip failed.
//
// Two different severities, deliberately:
//
//   • A MALFORMED value is always an error, in every environment. There is no
//     configuration in which a 40-character MASTER_KEY is what someone meant, and
//     continuing would store data under a key that can never be reproduced.
//
//   • A MISSING value is only fatal in production. Locally, running without a
//     dripper or without a database is a legitimate way to work on chain reads, and
//     a test that wants to exercise one module should not have to invent the rest
//     of the configuration first.

const problems = [];
const warnings = [];

const isProduction = process.env.NODE_ENV === 'production';

function checkSecret(name, pattern, description) {
  const value = process.env[name];
  if (!value) {
    if (isProduction) problems.push(`${name} is required in production. ${description}`);
    else warnings.push(`${name} is not set. ${description}`);
    return;
  }
  if (!pattern.test(value)) {
    problems.push(`${name} is malformed. ${description}`);
  }
}

checkSecret(
  'MASTER_KEY',
  /^[0-9a-fA-F]{64}$/,
  'It must be 64 hex characters — it seals every record key and keys the contact hash.'
);
checkSecret(
  'DRIPPER_PRIVATE_KEY',
  /^0x[0-9a-fA-F]{64}$/,
  'It must be a 0x-prefixed 32-byte key — new wallets cannot be funded without it.'
);
checkSecret(
  'CONTRACT_ADDRESS',
  /^0x[0-9a-fA-F]{40}$/,
  'It must be a 20-byte address — read signatures are verified against it.'
);
checkSecret(
  'RPC_URL',
  /^https?:\/\//,
  'It must be an http(s) endpoint. The server cannot read the chain without it.'
);
// Not a secret — but bound into the EIP-712 read domain, so it has to be right.
// A mismatch with the client's VITE_CHAIN_ID makes every signed read verify against
// a different domain and get rejected, which surfaces as "permissions are broken"
// rather than as a configuration error. Checked at boot so it cannot reach a user.
checkSecret(
  'CHAIN_ID',
  /^[0-9]+$/,
  'It must be the numeric chain id RPC_URL points at — Base Sepolia is 84532. ' +
    'It is bound into read signatures, so a mismatch rejects every one of them.'
);

// A wildcard CORS origin is the one setting that turns every other control into a
// suggestion, because it lets any page on the internet call this API with the
// user's browser. Refused outright rather than warned about.
const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (origins.includes('*')) {
  problems.push(
    'CORS_ORIGINS must not contain "*". Any site could then call this API from a user\'s ' +
      'browser. List the origins explicitly.'
  );
}
if (isProduction && origins.length === 0) {
  problems.push('CORS_ORIGINS is required in production. List the origins that may call this API.');
}
if (!isProduction && origins.length === 0) {
  warnings.push('CORS_ORIGINS is not set — defaulting to local development origins.');
}

if (problems.length > 0) {
  throw new Error(
    `\n\nConfiguration is not usable:\n${problems.map((line) => `  • ${line}`).join('\n')}\n\n` +
      `Fix server/.env (created from server/.env.example) and start again.\n`
  );
}

/** The parsed allowlist. Empty means "development defaults". */
export const corsOrigins = origins;

export const envWarnings = warnings;

if (warnings.length > 0 && process.env.NODE_ENV !== 'test') {
  for (const line of warnings) console.warn(`[Env] ${line}`);
}

