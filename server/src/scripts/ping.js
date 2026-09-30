/**
 * Database diagnostic.
 *
 *   npm run ping --workspace=server
 *
 * Atlas failures look alike from the outside but have very different fixes, so
 * this decodes the three that actually happen and says which one you have.
 */
// Must be first: loads server/.env before anything reads process.env.
import '../config/env.js';
import mongoose from 'mongoose';

const redact = (url) => {
  try {
    return url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:••••••@');
  } catch {
    return '(unparseable)';
  }
};

/** Turn a driver error into the actual fix. */
function diagnose(error) {
  const message = `${error.message || ''} ${error.reason?.message || ''}`;

  if (/IP that isn't whitelisted|whitelist|not allowed to access/i.test(message)) {
    return [
      'Your IP address is not on the Atlas allowlist.',
      'Fix: Atlas → Security → Network Access → Add IP Address.',
      'Your public IP is whatever https://api.ipify.org reports; it changes when',
      'your network does, so add 0.0.0.0/0 if you are demoing from a hotspot.',
    ];
  }
  if (/bad auth|Authentication failed|SCRAM/i.test(message)) {
    return [
      'The username or password is wrong.',
      'Check them against atlas-credentials.env. If your password contains characters',
      'like @ : / ? # [ ] %, they must be percent-encoded in the URL.',
      'Also confirm the user exists: Atlas → Security → Database Access.',
    ];
  }
  if (/ENOTFOUND|querySrv|ESERVFAIL|getaddrinfo/i.test(message)) {
    return [
      'The cluster hostname could not be resolved over DNS.',
      'Check the host in DATABASE_URL against Atlas → Database → Connect.',
      'A mongodb+srv:// URL needs working DNS SRV lookups — some VPNs and campus',
      'networks block them.',
    ];
  }
  if (/Server selection timed out|ETIMEDOUT|timeout/i.test(message)) {
    return [
      'Timed out before the cluster answered. Almost always the IP allowlist.',
      'Fix: Atlas → Security → Network Access → Add IP Address.',
      'The entry also takes a minute or two to become Active after you add it.',
    ];
  }
  return ['Unrecognised error — the message above is the whole story.'];
}

async function run() {
  const url = process.env.DATABASE_URL;
  console.log('\n  ApnaRecord · database check\n');

  if (!url) {
    console.error('  DATABASE_URL is not set in server/.env\n');
    process.exit(1);
  }

  console.log(`  url       ${redact(url)}`);

  const isSrv = url.startsWith('mongodb+srv://');
  console.log(`  kind      ${isSrv ? 'Atlas / SRV' : 'direct'}`);

  // Read the database name the way the driver will, so a missing path is visible.
  const withoutQuery = url.split('?')[0];
  const pathPart = withoutQuery.replace(/^mongodb(\+srv)?:\/\//, '').split('/')[1];
  if (!pathPart) {
    console.warn(
      '  database  (none in the URL) — the driver will use a database called "test".\n' +
        '            Add a name before the "?", e.g. ...mongodb.net/apnarecord?retryWrites=true'
    );
  } else {
    console.log(`  database  ${pathPart}`);
  }

  try {
    const started = Date.now();
    await mongoose.connect(url, { serverSelectionTimeoutMS: 15000 });
    const elapsed = Date.now() - started;

    const admin = mongoose.connection.db.admin();
    const info = await admin.serverInfo().catch(() => ({}));

    console.log(`  status    CONNECTED in ${elapsed} ms`);
    console.log(`  host      ${mongoose.connection.host}`);
    console.log(`  db        ${mongoose.connection.name}`);
    if (info.version) console.log(`  server    MongoDB ${info.version}`);

    // A real round-trip, so "connected" means "usable".
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log(`  collections  ${collections.length}`);
    for (const collection of collections) {
      const count = await mongoose.connection.db.collection(collection.name).countDocuments();
      console.log(`     ${collection.name.padEnd(16)} ${count} doc(s)`);
    }

    console.log('\n  Ready. Run `npm run index` to mirror chain state into the cache.\n');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error(`\n  status    FAILED\n`);
    const lines = diagnose(error);
    for (const line of lines) console.log(`  ${line}`);
    console.error(`\n  driver said: ${error.message.split('\n')[0]}\n`);
    process.exit(1);
  }
}

run();
