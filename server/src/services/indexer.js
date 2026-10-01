// THE INDEXER, AS A FUNCTION.
//
// This mirrors chain state into MongoDB, and it is the honest demonstration of the
// architecture's central claim: the database is a CACHE. Everything here can be deleted
// and rebuilt by running it again, because the chain is where the facts live.
//
// It used to live in scripts/ and end in `process.exit(0)`, which meant nothing could
// call it — so the cache only ever refreshed when a human remembered to run a command,
// and a dashboard could show yesterday's world while looking perfectly healthy. Splitting
// the work from the process lifecycle is what lets the API schedule it.
//
// Connection handling is deliberately NOT here. The caller decides whether to open its
// own connection and close it, because the API already has one and the CLI does not.

import { identities, events, recordMeta, call, blockTimestamps } from './chain.js';
import { IdentityModel, ChainEventModel, RecordModel, PatientLinkModel } from '../models/index.js';

const LINK_EVENT_NAMES = ['PatientLinkRequested', 'PatientLinked', 'PatientUnlinked'];

/**
 * Fold link events into the writes that collapse them to one row per pair.
 *
 * Pure, and exported, because the bug this replaces was invisible: every event was
 * applied and the wrong one won, so the only symptom was a hospital console showing
 * nobody. Returning the writes rather than performing them is what makes the ordering
 * assertable without a chain.
 *
 * The events arrive in the order `events()` returns them — NEWEST FIRST — and are
 * reversed here rather than at the call site. That is deliberate: the ordering IS the
 * rule, and a function that quietly depends on its caller to get it right is one whose
 * test passes while the deployment is wrong.
 */
export function foldLinkEvents(linkEvents, linkTimes = {}) {
  const writes = [];
  for (const event of [...linkEvents].reverse()) {
    const args = event.args || {};
    if (!args.facility || !args.patient) continue;
    const key = {
      facility: String(args.facility).toLowerCase(),
      patient: String(args.patient).toLowerCase(),
    };
    const iso = linkTimes[event.blockNumber];
    const at = iso ? new Date(iso) : null;
    if (event.name === 'PatientLinkRequested') {
      writes.push({ key, set: { state: 'requested', ...(at ? { requestedAt: at } : {}) } });
    } else if (event.name === 'PatientLinked') {
      // `endedAt` is cleared: a readmitted patient must not still carry a discharge date.
      writes.push({ key, set: { state: 'linked', endedAt: null, ...(at ? { consentedAt: at } : {}) } });
    } else if (event.name === 'PatientUnlinked') {
      writes.push({ key, set: { state: 'ended', ...(at ? { endedAt: at } : {}) } });
    }
  }
  return writes;
}

/**
 * One pass. Returns what it mirrored.
 *
 * `log` is injected rather than using console directly so a scheduled pass can be quiet
 * and the CLI can be chatty, without a flag threaded through the middle of the work.
 */
export async function runIndexer({ log = () => {} } = {}) {
  // ---- identities ---------------------------------------------------------
  const chainIdentities = await identities();
  for (const identity of chainIdentities) {
    // Labels are NEVER mirrored from the chain — the chain does not have them.
    // They arrive via POST /identities, so overwriting them here would wipe
    // every name on each pass. Only state and roles are mirrored.
    await IdentityModel.findOneAndUpdate(
      { account: identity.account.toLowerCase() },
      {
        $set: {
          account: identity.account.toLowerCase(),
          facility: String(identity.facility || '').toLowerCase(),
          active: identity.active,
          registeredAtBlock: identity.registeredAtBlock,
          roles: identity.roles,
        },
        $setOnInsert: { label: '' },
      },
      { upsert: true }
    );
  }
  log(`  identities   ${chainIdentities.length} mirrored`);

  // ---- records ------------------------------------------------------------
  //
  // Walked token by token from 1, because the contract has no enumeration and the count
  // is small. This is the part that does not scale, and pretending otherwise would be
  // worse than saying so.
  const nextTokenId = Number((await call('nextTokenId'))[0]);
  let recordCount = 0;
  for (let tokenId = 1; tokenId < nextTokenId; tokenId++) {
    const meta = await recordMeta(tokenId);
    if (!meta) continue;
    await RecordModel.findOneAndUpdate(
      { tokenId },
      {
        tokenId,
        patient: meta.patient.toLowerCase(),
        recordType: meta.recordType,
        recordHash: meta.recordHash.toLowerCase(),
        mintedAtBlock: meta.mintedAtBlock,
        mintedTx: meta.mintedTx,
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    recordCount++;
  }
  log(`  records      ${recordCount} mirrored  (tokens 1..${nextTokenId - 1})`);

  // ---- events -------------------------------------------------------------
  const chainEvents = await events(500);
  let eventCount = 0;
  for (const event of chainEvents) {
    try {
      // Key on the log's real position in the block, not a placeholder — see the note
      // in services/chain.js events().
      await ChainEventModel.updateOne(
        { txHash: event.txHash, name: event.name, logIndex: event.logIndex ?? 0 },
        { $setOnInsert: event },
        { upsert: true }
      );
      eventCount++;
    } catch {
      /* already indexed */
    }
  }
  log(`  events       ${eventCount} mirrored`);

  // ---- patient links ------------------------------------------------------
  //
  // Folded into one row per pair, so the current state is cheap to ask. Two things
  // here are load-bearing:
  //
  //   * `events()` returns the log NEWEST FIRST. Folding in that order inverts the
  //     outcome — a pair that was requested and then consented ends back at
  //     "requested", because the OLDEST event is applied last. `linkedPatientsOf`
  //     reads `state: 'linked'` to decide a hospital's read scope, so the console
  //     would show an empty patient list while the contract says otherwise. The fold
  //     runs ascending, the only order in which the last event wins.
  //   * Timestamps come from the block, not `new Date()`. The indexer re-reads the
  //     same window on every pass, so wall-clock time would reset "consented" to
  //     just-now on each run and the ledger could never show an age.
  const linkEvents = chainEvents.filter((e) => LINK_EVENT_NAMES.includes(e.name));
  const linkTimes = await blockTimestamps(linkEvents.map((e) => e.blockNumber));
  const linkWrites = foldLinkEvents(linkEvents, linkTimes);

  for (const write of linkWrites) {
    await PatientLinkModel.findOneAndUpdate(write.key, { $set: write.set }, { upsert: true });
  }
  log(`  links        ${linkWrites.length} mirrored`);

  return {
    identities: chainIdentities.length,
    records: recordCount,
    events: eventCount,
    links: linkWrites.length,
    at: new Date().toISOString(),
  };
}
