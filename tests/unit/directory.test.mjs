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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
