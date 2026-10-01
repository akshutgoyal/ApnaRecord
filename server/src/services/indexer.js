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

import { identities, events, recordMeta, call } from './chain.js';
import { IdentityModel, ChainEventModel, RecordModel, PatientLinkModel } from '../models/index.js';

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
  // Linked/requested/ended states mirror the link events. The server is the only
  // place the CURRENT state is cheap to ask — the chain holds the edges as
  // booleans, and this folds them into one row per pair.
  let linkCount = 0;
  for (const event of chainEvents) {
    const args = event.args || {};
    if (event.name === 'PatientLinkRequested' && args.facility && args.patient) {
      await PatientLinkModel.findOneAndUpdate(
        { facility: String(args.facility).toLowerCase(), patient: String(args.patient).toLowerCase() },
        { $set: { state: 'requested', requestedAt: new Date() }, $setOnInsert: { consentedAt: null, endedAt: null } },
        { upsert: true }
      );
      linkCount++;
    } else if (event.name === 'PatientLinked' && args.facility && args.patient) {
      await PatientLinkModel.findOneAndUpdate(
        { facility: String(args.facility).toLowerCase(), patient: String(args.patient).toLowerCase() },
        { $set: { state: 'linked', consentedAt: new Date() } },
        { upsert: true }
      );
      linkCount++;
    } else if (event.name === 'PatientUnlinked' && args.facility && args.patient) {
      await PatientLinkModel.findOneAndUpdate(
        { facility: String(args.facility).toLowerCase(), patient: String(args.patient).toLowerCase() },
        { $set: { state: 'ended', endedAt: new Date() } },
        { upsert: true }
      );
      linkCount++;
    }
  }
  log(`  links        ${linkCount} mirrored`);

  return {
    identities: chainIdentities.length,
    records: recordCount,
    events: eventCount,
    links: linkCount,
    at: new Date().toISOString(),
  };
}
