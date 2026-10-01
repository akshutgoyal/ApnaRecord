// The indexer's link fold, asserted without a chain.
//
// This exists because the bug it replaces was invisible. `events()` returns the log
// NEWEST FIRST, and the fold applied them in that order — so the OLDEST event won. A
// pair that was requested and then consented was recorded as merely "requested".
// Nothing threw and nothing logged; the only symptom was a hospital console showing an
// empty patient list while the contract said those patients were linked.
//
// The second bug is quieter still: the timestamps were `new Date()`, so every indexer
// pass reset "consented" to just-now and the ledger could never show an age.

import { foldLinkEvents } from '../../server/src/services/indexer.js';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const HOSPITAL = '0xc089766ad7B4E2835f1955D7f7122242CdDA978C';
const PATIENT = '0x194eFBB518Eb356Edb18B7088a7F13629b241348';

const ev = (name, blockNumber) => ({
  name,
  blockNumber,
  args: { facility: HOSPITAL, patient: PATIENT },
});

const times = {
  10: '2026-01-01T00:00:10.000Z',
  11: '2026-01-01T00:00:11.000Z',
  12: '2026-01-01T00:00:12.000Z',
};

// NEWEST FIRST — the order `events()` actually returns, and the order the bug got
// wrong. Feeding these oldest-first would pass against the broken code, which is the
// trap this test exists to avoid: the fold must not depend on its caller for ordering.
console.log('\nfoldLinkEvents — the newest event wins');
const linked = foldLinkEvents([ev('PatientLinked', 11), ev('PatientLinkRequested', 10)], times);
check(
  'a request then a consent ends up linked',
  linked.at(-1).set.state === 'linked',
  linked.map((w) => w.set.state).join(' -> ')
);
check(
  'the consent time is the block time, not the moment it was indexed',
  linked.at(-1).set.consentedAt.toISOString() === times[11],
  String(linked.at(-1).set.consentedAt)
);
check(
  'and the request time is the request block',
  linked[0].set.requestedAt.toISOString() === times[10],
  String(linked[0].set.requestedAt)
);
check(
  'the pair keys are lowercased so lookups match',
  linked.at(-1).key.facility === HOSPITAL.toLowerCase() &&
    linked.at(-1).key.patient === PATIENT.toLowerCase()
);

const discharged = foldLinkEvents(
  [ev('PatientUnlinked', 12), ev('PatientLinked', 11), ev('PatientLinkRequested', 10)],
  times
);
check('a discharge wins over the consent', discharged.at(-1).set.state === 'ended');

check(
  'a re-link clears the stale discharge date',
  foldLinkEvents([ev('PatientLinked', 12), ev('PatientLinked', 11)], times).at(-1).set.endedAt === null
);

console.log('\nfoldLinkEvents — what it must not do');
check(
  'an event with no patient is skipped rather than writing a row keyed by undefined',
  foldLinkEvents([{ name: 'PatientLinked', blockNumber: 1, args: {} }]).length === 0
);
check(
  'an unknown block still yields the state change',
  foldLinkEvents([ev('PatientLinked', 99)], {}).at(-1).set.state === 'linked'
);
check(
  'and invents no timestamp when the block time is unknown',
  !('consentedAt' in foldLinkEvents([ev('PatientLinked', 99)], {}).at(-1).set),
  'epoch-zero dates would be worse than none'
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
