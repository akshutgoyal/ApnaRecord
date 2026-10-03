// Remove enrolments left behind by the test suite.
//
// The suite signs up wallets with `@example.com` addresses and never picks a role, so
// those rows land in the admin console's "Awaiting an identity" list looking exactly like
// people waiting to be approved. They are not people.
//
// Three conditions must ALL hold before a row is deleted, because the cost of keeping a
// stray test row is a cluttered panel and the cost of deleting a real registration is
// somebody's account:
//
//   1. the contact is `@example.com` -- the suite's own domain, never a real one
//   2. no label            -- a labelled row is one an administrator has worked on
//   3. no requested role   -- a role means a person chose one on the way in
//
// Dry run by default. Pass --yes to delete.
//
//   node scripts/purge-test-enrolments.mjs
//   node scripts/purge-test-enrolments.mjs --yes
//
import 'dotenv/config';
import mongoose from 'mongoose';

const TEST_DOMAIN = '@example.com';
const confirmed = process.argv.includes('--yes');

const uri = process.env.DATABASE_URL;
if (!uri) {
  console.error('  DATABASE_URL is not set. Run this from server/ with its .env, or export it.');
  process.exit(1);
}

await mongoose.connect(uri);
const col = mongoose.connection.db.collection('enrolments');

const rows = await col
  .find({})
  .project({ address: 1, requestedRole: 1, 'identity.emailMasked': 1, 'identity.label': 1, createdAt: 1 })
  .sort({ createdAt: 1 })
  .toArray();

const removable = [];
const kept = [];

for (const row of rows) {
  const masked = row.identity?.emailMasked || '';
  const label = row.identity?.label || '';
  const role = row.requestedRole || '';
  const testContact = masked.endsWith(TEST_DOMAIN);

  if (testContact && !label && !role) removable.push(row);
  else kept.push({ row, why: !testContact ? 'a real contact' : label ? 'labelled' : 'has a role' });
}

console.log(`  ${rows.length} enrolments · ${removable.length} removable · ${kept.length} kept`);
console.log();

if (removable.length) {
  console.log('  WOULD DELETE');
  for (const row of removable) {
    const when = new Date(row.createdAt).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`    ${when}  ${row.identity?.emailMasked || '(no contact)'}  ${row.address}`);
  }
  console.log();
}

// Kept rows are printed too. A cleanup that only shows what it removes gives no way to
// notice that it should have removed something else.
if (kept.length) {
  console.log('  KEPT');
  for (const { row, why } of kept) {
    const when = new Date(row.createdAt).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`    ${when}  ${row.identity?.emailMasked || '(no contact)'}  ${row.address}  — ${why}`);
  }
  console.log();
}

if (!confirmed) {
  console.log('  Dry run. Nothing was deleted. Re-run with --yes to remove the rows above.');
} else if (!removable.length) {
  console.log('  Nothing to delete.');
} else {
  const result = await col.deleteMany({ _id: { $in: removable.map((r) => r._id) } });
  console.log(`  Deleted ${result.deletedCount} test enrolments.`);
}

await mongoose.disconnect();
