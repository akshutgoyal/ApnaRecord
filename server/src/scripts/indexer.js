/**
 * Indexer — mirror chain state into MongoDB.
 *
 *   npm run index --workspace=server
 *
 * The work itself lives in services/indexer.js, because the API schedules the same
 * function. This file only handles the things that belong to a one-shot process: loading
 * .env, opening a connection, and deciding an exit code.
 *
 * Requires DATABASE_URL to point at a reachable MongoDB. The API itself does not need
 * MongoDB at all — it falls back to reading the chain directly.
 */
// Must be first: loads server/.env before anything reads process.env.
import '../config/env.js';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { runIndexer } from '../services/indexer.js';

async function main() {
  console.log('\n  ApnaRecord indexer\n');

  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    console.error('  No database connection. Set DATABASE_URL in server/.env and try again.');
    process.exit(1);
  }

  const result = await runIndexer({ log: (line) => console.log(line) });

  console.log(`\n  Done at ${result.at}. The database can be dropped and rebuilt at any time.\n`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('\n  Indexer failed:', error.shortMessage || error.message, '\n');
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
