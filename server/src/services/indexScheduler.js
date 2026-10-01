// THE INDEXER ON A TIMER.
//
// The cache used to refresh only when somebody ran `npm run index`, which meant a
// dashboard could render yesterday's world and look entirely healthy while doing it. An
// invisible staleness is worse than a visible error, because nobody goes looking.
//
// IN-PROCESS IS A CHOICE, AND IT HAS A CEILING. One server means one scheduler, which is
// correct. Two servers means two schedulers doing identical work and racing each other's
// writes — harmless here, because every write is an idempotent upsert keyed on chain
// data, but wasteful. Past one instance this wants to be a single leader or a real queue.
// That is a note, not a queue to build now.

import { isDbReady } from '../models/index.js';
import { runIndexer } from './indexer.js';

const DEFAULT_INTERVAL_MS = 60_000;

function intervalMs() {
  const configured = Number(process.env.INDEX_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 5_000 ? configured : DEFAULT_INTERVAL_MS;
}

function enabled() {
  // On by default. Off is for a deliberate choice — an RSS-noise-free demo, or a process
  // that must not touch the database.
  return String(process.env.INDEX_ENABLED ?? 'true').toLowerCase() !== 'false';
}

let timer = null;
/** Overlap guard. A pass that outlives its interval must not be joined by the next one. */
let running = false;
let lastResult = null;
let lastError = null;

async function pass() {
  if (running) {
    console.warn('[Indexer] previous pass is still running — skipping this tick');
    return;
  }
  if (!isDbReady()) {
    // Not an error. Without a database the API reads the chain directly, so there is
    // simply nothing to cache into.
    return;
  }

  running = true;
  const started = Date.now();
  try {
    lastResult = await runIndexer();
    lastError = null;
  } catch (error) {
    lastError = error?.shortMessage || error?.message || String(error);
    // Loud, but never fatal: the chain still answers every read, so a failed index is
    // degraded rather than broken.
    console.error('[Indexer] pass failed:', lastError);
  } finally {
    running = false;
    const took = Date.now() - started;
    if (took > intervalMs()) {
      console.warn(
        `[Indexer] a pass took ${Math.round(took / 1000)}s, longer than its ` +
          `${Math.round(intervalMs() / 1000)}s interval — raise INDEX_INTERVAL_MS`
      );
    }
  }
}

export function startIndexScheduler() {
  if (!enabled()) {
    console.log('[Indexer] disabled (INDEX_ENABLED=false) — the cache will go stale');
    return () => {};
  }
  if (timer) return stopIndexScheduler;

  const ms = intervalMs();
  timer = setInterval(() => {
    pass().catch(() => {});
  }, ms);

  console.log(`[Indexer] scheduled every ${Math.round(ms / 1000)}s`);
  return stopIndexScheduler;
}

export function stopIndexScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** What the last pass did, for a status endpoint or a startup banner. */
export function indexerStatus() {
  return {
    enabled: enabled(),
    intervalMs: intervalMs(),
    running,
    lastResult,
    lastError,
  };
}
