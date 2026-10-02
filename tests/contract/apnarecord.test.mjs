// APNARECORD, EXECUTED FOR REAL.
//
// The only suite that runs ApnaRecord on an EVM. Everything else either stubs the chain
// (and a stub cannot execute contract logic) or tests ApnaRecordAccount. So this is where
// the rules that actually protect patients are checked:
//
//   • a hospital cannot link a patient without that patient's consent
//   • a hospital cannot mint for a patient it is not treating
//   • discharge actually removes visibility
//   • the events carry no clinical data — no record type, no label, no break-glass reason
//
// It deploys a real ApnaRecordAccount as the patient, rather than using an EOA, because
// the account is a CONTRACT and the mint has to reach it. That distinction is not
// academic: `_safeMint` reverts for a contract without `onERC721Received`, which would
// have failed every mint to a real patient and passed every test that used an EOA.
//
// Run from the project root:  node tests/contract/apnarecord.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import solc from 'solc';
import { ethers } from 'ethers';
import { check, group, report } from '../support/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

/**
 * Compile with OpenZeppelin resolved out of node_modules.
 *
 * ApnaRecord imports OpenZeppelin, so a single-file compile fails with "Source not
 * found" for every import — which reads like a broken contract rather than a missing
 * resolver.
 */
function compile(relativePath, evmVersion = 'cancun') {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [path.basename(relativePath)]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (importPath) => {
        try {
          return { contents: fs.readFileSync(path.join(root, 'node_modules', importPath), 'utf8') };
        } catch (error) {
          return { error: `Could not resolve ${importPath}: ${error.message}` };
        }
      },
    })
  );
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const name = path.basename(relativePath).replace(/\.sol$/, '');
  return output.contracts[path.basename(relativePath)][name];
}

/** The name of the custom error a call reverted with, or null if it succeeded. */
async function revertName(promise, iface) {
  try {
    await promise;
    return null;
  } catch (error) {
    const data = error?.data ?? error?.info?.error?.data ?? null;
    if (typeof data === 'string' && data.startsWith('0x') && iface) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return parsed.name;
      } catch {
        /* not one of ours */
      }
    }
    return error?.shortMessage || error?.message || 'reverted';
  }
}

/** The value a call returned, or the name of the error it reverted with. */
async function callOrError(promise, iface) {
  try {
    return { value: await promise };
  } catch (error) {
    const data = error?.data ?? error?.info?.error?.data ?? null;
    if (typeof data === 'string' && data.startsWith('0x') && iface) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return { error: parsed.name };
      } catch {
        /* not one of ours */
      }
    }
    return { error: error?.shortMessage || error?.message || 'reverted' };
  }
}

group('setup');

// ganache writes a banner straight to stdout which interleaves with the summary line
// when this runs through the runner, turning "23 passed" into "22043223 passed".
const realStdoutWrite = process.stdout.write.bind(process.stdout);
let evm;
process.stdout.write = () => true;
try {
  evm = ganache.provider({ logging: { quiet: true } });
} finally {
  process.stdout.write = realStdoutWrite;
}
const provider = new ethers.BrowserProvider(evm);

const signerFor = async (index) => {
  const accounts = await provider.listAccounts();
  return provider.getSigner(accounts[index].address);
};

const admin = await signerFor(0);
const hospital = await signerFor(1);
const otherHospital = await signerFor(2);
const stranger = await signerFor(4);
const patientKey = await signerFor(5);

const adminAddress = await admin.getAddress();
const hospitalAddress = await hospital.getAddress();
const otherHospitalAddress = await otherHospital.getAddress();

// Compiled at SHANGHAI for this suite, not Cancun, and that is not a detail.
//
// The deployed artifact targets Cancun because OpenZeppelin needs `mcopy`. Ganache is a
// pre-Cancun EVM, so cancun-targeted bytecode hits an invalid opcode the moment it copies
// dynamic memory — which `string.concat` does. An invalid opcode consumes all gas and
// returns NO revert data, so it presents as "missing revert data" on a function that has
// no revert in it at all.
//
// It cost a detour: `viewRecord` and `didFor` both "failed", and `didFor` is a trivial
// string builder that cannot fail. Compiling the test copy at Shanghai removes the
// mismatch so the suite tests the contract's LOGIC rather than ganache's age. The
// artifact that gets deployed is still Cancun.
const compiled = compile('contracts/ApnaRecord.sol', 'shanghai');
const factory = new ethers.ContractFactory(
  compiled.abi,
  `0x${compiled.evm.bytecode.object}`,
  admin
);
const apna = await factory.deploy();
await apna.waitForDeployment();
const apnaAddress = await apna.getAddress();
const iface = new ethers.Interface(compiled.abi);

// The patient is a CONTRACT, as in production.
const accountArtifact = JSON.parse(
  fs.readFileSync(path.join(root, 'contracts/artifacts/ApnaRecordAccount.json'), 'utf8')
);
const accountFactory = new ethers.ContractFactory(
  accountArtifact.abi,
  accountArtifact.bytecode,
  patientKey
);
const patientAccount = await accountFactory.deploy(await patientKey.getAddress(), [apnaAddress]);
await patientAccount.waitForDeployment();
const patientAddress = await patientAccount.getAddress();

check('ApnaRecord deployed', ethers.isAddress(apnaAddress), apnaAddress);
check(
  'the patient is a contract, not an EOA',
  (await provider.getCode(patientAddress)) !== '0x',
  patientAddress
);

// ---------------------------------------------------------------- facilities
group('facilities');

await (await apna.connect(admin).createFacility(hospitalAddress)).wait();
await (await apna.connect(admin).createFacility(otherHospitalAddress)).wait();

check('a facility is registered', await apna.facilities(hospitalAddress));
check(
  'a stranger cannot create one',
  (await revertName(
    apna.connect(stranger).createFacility.staticCall(adminAddress),
    iface
  )) === 'AccessControlUnauthorizedAccount',
  'admin-only'
);

const hospitalRole = await apna.HOSPITAL_ROLE();
await (await apna.connect(admin).grantRole(hospitalRole, hospitalAddress)).wait();
await (await apna.connect(admin).grantRole(hospitalRole, otherHospitalAddress)).wait();
check('the hospital holds HOSPITAL_ROLE', await apna.hasRole(hospitalRole, hospitalAddress));

// ------------------------------------------------------------------ identity
group('identity registration');

await (await apna.connect(admin).createIdentity(adminAddress, ethers.ZeroAddress)).wait();
check('the platform may register an identity', (await apna.identities(adminAddress))[1]);

await (await apna.connect(hospital).createIdentity(patientAddress, ethers.ZeroAddress)).wait();
const patientIdentity = await apna.identities(patientAddress);
check('a hospital may register a patient', patientIdentity[1]);
check(
  'and the patient is NOT filed as hospital staff',
  patientIdentity[2] === ethers.ZeroAddress,
  `facility=${patientIdentity[2]}`
);

const doctorAddress = await (await signerFor(3)).getAddress();
await (await apna.connect(hospital).createIdentity(doctorAddress, hospitalAddress)).wait();
check(
  'a hospital may register its own staff, with itself as the facility',
  (await apna.identities(doctorAddress))[2] === hospitalAddress
);

check(
  'a hospital cannot write into another hospital roster',
  (await revertName(
    apna.connect(hospital).createIdentity.staticCall(stranger.getAddress(), otherHospitalAddress),
    iface
  )) === 'NotAuthorized',
  'cross-facility refused'
);
check(
  'a non-facility cannot register anyone',
  (await revertName(
    apna.connect(stranger).createIdentity.staticCall(stranger.getAddress(), ethers.ZeroAddress),
    iface
  )) === 'NotAuthorized',
  'refused'
);

// ------------------------------------------------------------ consent to link
group('the consent handshake');

check(
  'a wallet without HOSPITAL_ROLE cannot request a link',
  (await revertName(
    apna.connect(stranger).requestPatientLink.staticCall(patientAddress),
    iface
  )) === 'AccessControlUnauthorizedAccount',
  'role-gated'
);

await (await apna.connect(hospital).requestPatientLink(patientAddress)).wait();
check('the request is recorded', await apna.pendingLink(hospitalAddress, patientAddress));
check(
  'but requesting grants nothing',
  !(await apna.facilityPatient(hospitalAddress, patientAddress)),
  'pending only'
);

// The patient approves THROUGH the account, which is how it works in production.
const acctIface = new ethers.Interface(accountArtifact.abi);
const approveViaAccount = acctIface.encodeFunctionData('execute', [
  apnaAddress,
  0,
  iface.encodeFunctionData('approvePatientLink', [hospitalAddress]),
]);

check(
  'a stranger cannot approve for the patient',
  (await revertName(
    apna.connect(stranger).approvePatientLink.staticCall(hospitalAddress),
    iface
  )) === 'LinkNotRequested',
  'only the requested patient'
);

await (await patientAccount.connect(patientKey).execute(apnaAddress, 0,
  iface.encodeFunctionData('approvePatientLink', [hospitalAddress]))).wait();

check('the patient consented, via the account', await apna.facilityPatient(hospitalAddress, patientAddress));
check(
  'and the hospital now lists them',
  (await apna.linkedPatients(hospitalAddress)).includes(patientAddress)
);
check('no longer pending', !(await apna.pendingLink(hospitalAddress, patientAddress)));

// ------------------------------------------------------------- the mint gate
group('the mint gate');

const digest = ethers.keccak256(ethers.toUtf8Bytes('a-record'));

check(
  'a hospital cannot mint for a patient it is not treating',
  (await revertName(
    apna.connect(otherHospital).mintRecord.staticCall(patientAddress, digest, 'local://x'),
    iface
  )) === 'PatientNotLinked',
  'PatientNotLinked'
);

const mintTx = await (await apna.connect(hospital).mintRecord(patientAddress, digest, 'local://x')).wait();
const minted = mintTx.logs
  .map((log) => { try { return iface.parseLog(log); } catch { return null; } })
  .find((parsed) => parsed?.name === 'RecordMinted');

check('a hospital mints for a linked patient', minted !== undefined, `token ${minted?.args[0]}`);
check(
  'the mint reached the patient ACCOUNT contract',
  (await apna.ownerOf(1)) === patientAddress,
  `owner=${await apna.ownerOf(1)}`
);

group('the events carry no clinical data');

check(
  'RecordMinted names neither the patient nor the record type',
  minted.args.length === 2,
  `${minted.args.length} args: tokenId, recordHash`
);
check('and the digest is still published, as the integrity anchor', minted.args[1] === digest);

const identityTx = await (await apna.connect(admin).createIdentity(await stranger.getAddress(), ethers.ZeroAddress)).wait();
const identityLog = identityTx.logs
  .map((log) => { try { return iface.parseLog(log); } catch { return null; } })
  .find((parsed) => parsed?.name === 'IdentityCreated');
check(
  'IdentityCreated carries no label',
  identityLog.args.length === 2,
  `${identityLog.args.length} args: account, facility`
);

check(
  'EmergencyAccessUsed has no reason field',
  iface.getEvent('EmergencyAccessUsed').inputs.length === 3,
  'tokenId, viewer, expiresAt'
);
check(
  'RecordRequested names no patient',
  iface.getEvent('RecordRequested').inputs.length === 2,
  'requestId, requester'
);

group('privacy of the consent mapping');

check(
  'consent has no public getter',
  iface.getFunction('consent') === null,
  'the accepted graph cannot be enumerated in bulk'
);
check('canAccess is the only route', iface.getFunction('canAccess') !== null);

// ---------------------------------------------------------------- discharge
group('discharge removes visibility');

const second = await signerFor(6);
const secondAddress = await second.getAddress();
await (await apna.connect(hospital).createIdentity(secondAddress, ethers.ZeroAddress)).wait();
await (await apna.connect(hospital).requestPatientLink(secondAddress)).wait();
await (await apna.connect(second).approvePatientLink(hospitalAddress)).wait();

const linked = await apna.linkedPatients(hospitalAddress);
check('two patients are linked', linked.length === 2, `${linked.length}`);

await (await apna.connect(hospital).dischargePatient(patientAddress)).wait();
check('discharge ends the link', !(await apna.facilityPatient(hospitalAddress, patientAddress)));
check(
  'and the swapped list is still correct',
  (await apna.linkedPatients(hospitalAddress)).length === 1 &&
    (await apna.linkedPatients(hospitalAddress))[0] === secondAddress,
  'swap-and-pop left no hole'
);
check(
  'the record survives discharge — only the hospital lost sight of it',
  (await apna.ownerOf(1)) === patientAddress
);
check(
  'and the hospital can no longer mint for them',
  (await revertName(
    apna.connect(hospital).mintRecord.staticCall(patientAddress, digest, 'local://y'),
    iface
  )) === 'PatientNotLinked',
  'PatientNotLinked'
);

check(
  'the patient may revoke unilaterally',
  (await revertName(
    apna.connect(second).revokePatientLink.staticCall(hospitalAddress),
    iface
  )) === null,
  'no hospital cooperation needed'
);

// --------------------------------------------------------------- the record
group('the record itself');

check('the record is soulbound', await apna.locked(1));
check(
  'and cannot be transferred',
  (await revertName(
    apna.connect(patientKey).transferFrom.staticCall(patientAddress, secondAddress, 1),
    iface
  )) === 'NotAuthorized',
  'transfer blocked in _update'
);

const auditorRole = await apna.AUDITOR_ROLE();
await (await apna.connect(admin).grantRole(auditorRole, adminAddress)).wait();
const audited = await apna.connect(admin).auditRecord(1);
check(
  'auditRecord returns no record type',
  audited.length === 3,
  `${audited.length} values: recordHash, mintedAt, owner`
);
check('verifyRecord still confirms the digest', await apna.verifyRecord(1, digest));

// -------------------------------------------------- the patient's own control
group('the patient controls access');

const viewer = await signerFor(7);
const viewerAddress = await viewer.getAddress();

check(
  'a stranger cannot read a record before any consent',
  (await revertName(apna.connect(viewer).viewRecord.staticCall(1), iface)) === 'AccessDenied',
  'AccessDenied'
);

// The patient grants THROUGH the account, as in production.
await (await patientAccount.connect(patientKey).execute(
  apnaAddress,
  0,
  iface.encodeFunctionData('grantAccess', [1, viewerAddress, 3600])
)).wait();

check('the grant takes effect', await apna.canAccess(1, viewerAddress));

const readBack = await callOrError(apna.connect(viewer).viewRecord.staticCall(1), iface);
check(
  'and the consented viewer can now read the file location',
  readBack.value === 'local://x',
  readBack.error ? `reverted with ${readBack.error}` : `returned ${readBack.value}`
);

// And the contract still refuses everyone else, which is the whole point.
check(
  'a different stranger is still refused',
  (await revertName(apna.connect(second).viewRecord.staticCall(1), iface)) === 'AccessDenied',
  'consent is per-viewer'
);

const revokeTx = await (await patientAccount.connect(patientKey).execute(
  apnaAddress,
  0,
  iface.encodeFunctionData('revokeAccess', [1, viewerAddress])
)).wait();
check('revocation is recorded', revokeTx.logs.length > 0);
check('and access ends immediately', !(await apna.canAccess(1, viewerAddress)));
check(
  'the viewer is refused again',
  (await revertName(apna.connect(viewer).viewRecord.staticCall(1), iface)) === 'AccessDenied',
  'AccessDenied'
);

// ------------------------------------------------- break-glass, burn and retire
//
// The three writes the rest of the suite never reached. Each one either hands access
// out or takes a record away, so each is worth proving rather than assuming — and two
// of them are the only routes that can undo something a patient owns.

group('break-glass');

const managerRole = await apna.MANAGER_ROLE();
const clinician = await signerFor(8);
const clinicianAddress = await clinician.getAddress();
const outsider = await signerFor(9);
const outsiderAddress = await outsider.getAddress();

await (await apna.connect(admin).grantRole(managerRole, clinicianAddress)).wait();

check(
  'a wallet without MANAGER_ROLE cannot break the glass',
  (await revertName(
    apna.connect(outsider).emergencyAccess.staticCall(1, outsiderAddress),
    iface
  )) === 'AccessControlUnauthorizedAccount',
  'role-gated'
);
check(
  'breaking the glass on a record that does not exist is refused',
  (await revertName(
    apna.connect(clinician).emergencyAccess.staticCall(9999, clinicianAddress),
    iface
  )) === 'RecordNotFound',
  'RecordNotFound'
);

const breakTx = await (await apna.connect(clinician).emergencyAccess(1, outsiderAddress)).wait();
const breakNames = breakTx.logs
  .map((log) => { try { return iface.parseLog(log)?.name; } catch { return null; } })
  .filter(Boolean);

check('the clinician can break the glass', await apna.canAccess(1, outsiderAddress));
// The distinction matters for the audit trail. Break-glass is a clinician reading
// without the patient, and an auditor has to be able to tell that apart from a
// patient who chose to share — which is only true if the two emit different events.
check(
  'and it is logged as an emergency, not as a consented grant',
  breakNames.includes('EmergencyAccessUsed') && !breakNames.includes('AccessGranted'),
  breakNames.join(', ')
);

// The window is one hour, and the contract is what closes it. A read of `canAccess`
// now would pass even if the expiry were in the year 3000, so the chain is advanced
// past it — the only way to prove a timeout actually times out.
// 3590, not 3599. ganache stamps each block with wall-clock time unless told
  // otherwise, so real seconds accumulate across the RPC calls in between -- and at
  // 3599 the window could close before the assertion ran, making this flaky by
  // construction. Ten seconds of slack costs nothing and removes the race.
  await evm.request({ method: 'evm_increaseTime', params: [3590] });
await evm.request({ method: 'evm_mine', params: [] });
// Still open a second short of the hour. Without this the check below would pass just
// as happily for a window of one second, and would be proving almost nothing.
check(
  'the window is still open just short of the hour',
  await apna.canAccess(1, outsiderAddress),
  'not yet expired'
);

await evm.request({ method: 'evm_increaseTime', params: [11] });
await evm.request({ method: 'evm_mine', params: [] });
check(
  'and closes at the hour rather than never',
  !(await apna.canAccess(1, outsiderAddress)),
  'expired'
);

group('revocation');

const burnDigest = ethers.keccak256(ethers.toUtf8Bytes('a-record-to-burn'));
const burnTx = await (await apna.connect(hospital).mintRecord(secondAddress, burnDigest, 'local://z')).wait();
const burnToken = Number(
  burnTx.logs
    .map((log) => { try { return iface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === 'RecordMinted').args[0]
);

check(
  'a hospital cannot revoke a record',
  (await revertName(apna.connect(hospital).revokeRecord.staticCall(burnToken), iface)) ===
    'AccessControlUnauthorizedAccount',
  'admin-only'
);
await (await apna.connect(admin).revokeRecord(burnToken)).wait();
check(
  'the burned record no longer exists',
  (await revertName(apna.ownerOf.staticCall(burnToken), iface)) === 'ERC721NonexistentToken',
  'gone from supply'
);
check(
  'and revoking it twice is refused rather than silently succeeding',
  (await revertName(apna.connect(admin).revokeRecord.staticCall(burnToken), iface)) ===
    'RecordNotFound',
  'RecordNotFound'
);

group('retiring an identity');

const strangerAddress = await stranger.getAddress();

check(
  'a hospital cannot retire an identity',
  (await revertName(apna.connect(hospital).deactivateIdentity.staticCall(strangerAddress), iface)) ===
    'AccessControlUnauthorizedAccount',
  'admin-only'
);
await (await apna.connect(admin).deactivateIdentity(strangerAddress)).wait();
check('the identity is retired', (await apna.identities(strangerAddress))[1] === false);
check(
  'a retired identity cannot be linked',
  (await revertName(apna.connect(hospital).requestPatientLink.staticCall(strangerAddress), iface)) ===
    'IdentityNotFound',
  'IdentityNotFound'
);
check(
  'and retiring it twice is refused',
  (await revertName(apna.connect(admin).deactivateIdentity.staticCall(strangerAddress), iface)) ===
    'IdentityNotFound',
  'IdentityNotFound'
);

report();
