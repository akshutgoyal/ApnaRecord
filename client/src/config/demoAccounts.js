// The wallets used in the demo walkthrough.
//
// These are CONVENIENCE ONLY. The app never decides a role from this file — it
// asks the contract (see useChain). This list exists so that address fields can
// offer a one-click fill instead of asking anyone to paste 42 hex characters,
// and so the home page can show what the demo accounts are.
//
// Two things changed with the privacy rewrite, and both matter here:
//
//   * These addresses hold NOTHING on the current contract. It is freshly
//     deployed, so `nextTokenId` and `nextRequestId` are both 1 and no role has
//     been granted. This list is the intended cast, not a record of what is
//     registered — re-register them through the Admin console.
//   * The LABELS below are no longer recoverable from the chain. `IdentityCreated`
//     used to carry one; it now carries only the account and its facility, and the
//     label lives in the database. So a label here and a label in the database can
//     disagree, and the database is the one the UI shows.
//
// Target contract: 0x0afBDd549aE57818A428Be35ee55d7f6715CD5cA
//
// Hospital 101 is the first facility. Its IT wallet IS the facility on-chain.
// (that is Phase D, with the facility console). The address is recorded here so it is not
// lost: 0xc089766ad7B4E2835f1955D7f7122242CdDA978C. It has been funded, and on-chain it
// is the facility — the key that `createFacility` names and `HOSPITAL_ROLE` is granted to.
// Its name lives in the database (POST /facilities), because names are off-chain now.

export const DEMO_ACCOUNTS = [
  {
    key: 'admin',
    role: 'admin',
    label: 'Platform',
    address: '0x436625C20e1f90133c52B6C1728709B295fd82B6',
    note: 'Deployed the current contract. Holds DEFAULT_ADMIN_ROLE — the only wallet that can mint, grant roles and create facilities.',
  },
  {
    key: 'hospital',
    role: 'hospital',
    label: 'Hospital 101',
    address: '0xc089766ad7B4E2835f1955D7f7122242CdDA978C',
    note: 'Holds HOSPITAL_ROLE. Links patients with their consent, mints for linked patients, manages own staff.',
  },
  {
    key: 'doctor',
    role: 'doctor',
    label: 'Doctor 101',
    address: '0xF571447d95883AE1b9596bfd8a32D2713a80EA63',
    note: 'Holds MANAGER_ROLE once granted. Requests records and reads with a patient consent window.',
  },
  {
    key: 'auditor',
    role: 'auditor',
    label: 'Auditor 101',
    address: '0x62A4A7C6dA55aBB06012222F97318B53E784636e',
    note: 'Holds AUDITOR_ROLE once granted. Sees metadata and the event log, never a file.',
  },
  {
    key: 'patient',
    role: 'patient',
    label: 'Patient 101',
    address: '0x194eFBB518Eb356Edb18B7088a7F13629b241348',
    note: 'Owns the records minted to it. Grants and revokes access to its own record.',
  },
];

export const DEMO_ADDRESSES = DEMO_ACCOUNTS.map((a) => a.address);

/** Look up a demo account by address (case-insensitive). */
export function demoAccountFor(address) {
  if (!address) return null;
  return (
    DEMO_ACCOUNTS.find((a) => a.address.toLowerCase() === address.toLowerCase()) || null
  );
}
