/**
 * Indexer — mirror chain state into MongoDB.
 *
 *   npm run index --workspace=server
 *
 * This is the honest demonstration of the architecture's central claim: MongoDB
 * is a CACHE, not a source of truth. Everything here can be deleted and rebuilt
 * by running this script again, because the chain is where the facts live.
 *
 * Requires DATABASE_URL to point at a reachable MongoDB. The API itself does not
 * need MongoDB at all — it falls back to reading the chain directly.
 */
// Must be first: loads server/.env before anything reads process.env.
import '../config/env.js';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { identities, events, recordMeta, call } from '../services/chain.js';
import { IdentityModel, ChainEventModel, RecordModel } from '../models/index.js';

async function run() {
  console.log('\n  ApnaRecord indexer\n');

  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    console.error('  No database connection. Set DATABASE_URL in server/.env and try again.');
    process.exit(1);
  }

  // ---- identities ---------------------------------------------------------
  const chainIdentities = await identities();
  for (const identity of chainIdentities) {
    await IdentityModel.findOneAndUpdate(
      { account: identity.account.toLowerCase() },
      {
        account: identity.account.toLowerCase(),
        label: identity.label,
        active: identity.active,
        registeredAtBlock: identity.registeredAtBlock,
        roles: identity.roles,
      },
      { upsert: true }
    );
  }
  console.log(`  identities   ${chainIdentities.length} mirrored`);

  // ---- records ------------------------------------------------------------
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
  console.log(`  records      ${recordCount} mirrored  (tokens 1..${nextTokenId - 1})`);

  // ---- events -------------------------------------------------------------
  const chainEvents = await events(500);
  let eventCount = 0;
  for (const event of chainEvents) {
    try {
      // Key on the log's real position in the block, not a placeholder — see
      // the note in services/chain.js events().
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
  console.log(`  events       ${eventCount} mirrored`);

  console.log('\n  Done. The database can be dropped and rebuilt at any time.\n');
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (error) => {
  console.error('\n  Indexer failed:', error.shortMessage || error.message, '\n');
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
