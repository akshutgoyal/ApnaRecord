// The directory wire formats, asserted byte-identical on both sides.
//
// The client and the server deploy separately and cannot share an import, so
// these strings are duplicated. Drift here is not cosmetic: the server would
// reject every signature the client produces, and the failure would present as
// "permissions are broken".

import {
  identityMessage as clientIdentity,
  facilityMessage as clientFacility,
  requestMessage as clientRequest,
} from '../../client/src/lib/wireMessages.js';
import {
  identityMessage as serverIdentity,
  facilityMessage as serverFacility,
  requestMessage as serverRequest,
  identityWriteVerdict,
  requestWriteVerdict,
} from '../../server/src/controllers/directoryController.js';

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

const account = '0x194eFBB518Eb356Edb18B7088a7F13629b241348';
const facility = '0xc089766ad7B4E2835f1955D7f7122242CdDA978C';

console.log('\nidentityMessage');
check(
  'agrees with empty facility',
  clientIdentity(account, 'Cardiology', '', 123) === serverIdentity(account, 'Cardiology', '', 123)
);
check(
  'agrees with a facility',
  clientIdentity(account, 'Doctor 101', facility, 456) ===
    serverIdentity(account, 'Doctor 101', facility, 456)
);
check(
  'trims the label the same way',
  clientIdentity(account, '  x  ', '', 1) === serverIdentity(account, '  x  ', '', 1)
);

console.log('\nfacilityMessage');
check(
  'agrees',
  clientFacility(facility, 'City Care', 789) === serverFacility(facility, 'City Care', 789)
);

console.log('\nrequestMessage');
check(
  'agrees',
  clientRequest(7, account, 'MRI_SCAN', 101112) === serverRequest(7, account, 'MRI_SCAN', 101112)
);
check(
  'lowercase hash input matches either way',
  clientRequest(7, account.toLowerCase(), 'XRAY', 5) ===
    serverRequest(7, account.toLowerCase(), 'XRAY', 5)
);

// The directory is a shared, append-only-ish resource. `createIdentity` on-chain
// reverts `IdentityExists` rather than rewriting, and these pin the server to the
// same rule — otherwise any hospital could relabel another hospital's staff, or
// clear their facility to zero so the directory presents a colleague as a patient.
console.log('\nidentityWriteVerdict');
check(
  'the platform may change an existing record',
  identityWriteVerdict({ existing: { label: 'a', facility: '' }, facility: '', label: 'b', isAdmin: true }) === null
);
check(
  'a creating write is allowed',
  identityWriteVerdict({ existing: null, facility: '', label: 'Patient 101', isAdmin: false }) === null
);
check(
  're-sending an identical row is a no-op, not a conflict',
  identityWriteVerdict({
    existing: { label: 'Patient 101', facility: '' },
    facility: '',
    label: 'Patient 101',
    isAdmin: false,
  }) === null
);
check(
  'relabelling it is refused',
  identityWriteVerdict({
    existing: { label: 'Patient 101', facility: '' },
    facility: '',
    label: 'Struck off',
    isAdmin: false,
  })?.status === 409
);
check(
  'clearing a colleague’s facility to zero is refused',
  identityWriteVerdict({
    existing: { label: 'Doctor 101', facility: facility.toLowerCase() },
    facility: '',
    label: 'Doctor 101',
    isAdmin: false,
  })?.status === 409
);
check(
  'and the refusal is named IdentityExists, matching the chain',
  identityWriteVerdict({
    existing: { label: 'a', facility: '' },
    facility: '',
    label: 'b',
    isAdmin: false,
  })?.error === 'IdentityExists'
);

console.log('\nrequestWriteVerdict');
check(
  'a first filing is allowed',
  requestWriteVerdict({ existing: null, requester: account.toLowerCase() }) === null
);
check(
  're-filing your own request is a no-op',
  requestWriteVerdict({
    existing: { requester: account.toLowerCase() },
    requester: account.toLowerCase(),
  }) === null
);
check(
  'rewriting another clinician’s request is refused',
  requestWriteVerdict({
    existing: { requester: facility.toLowerCase() },
    requester: account.toLowerCase(),
  })?.status === 403
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
