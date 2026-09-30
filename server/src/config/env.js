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
