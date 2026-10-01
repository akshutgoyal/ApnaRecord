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

export const DEMO_ACCOUNTS = [
  {
    key: 'admin',
    role: 'admin',
    label: 'Hospital IT',
    address: '0xcd026C498Ed36Ba54A9c42CEC6CbdFE1cFD96608',
    note: 'Deployed the contract. Holds DEFAULT_ADMIN_ROLE — the only wallet that can mint.',
  },
  {
    key: 'doctor',
    role: 'doctor',
    label: 'Cardiology',
    address: '0x06Ef1262F7Ab61a960b075833ebf655277d823C6',
    note: 'Holds MANAGER_ROLE. Requested the first record and was granted the first consent window.',
  },
  {
    key: 'auditor',
    role: 'auditor',
    label: 'Compliance',
    address: '0xF2538724d814ef3900095f6e0fa0DFac8F9ad31d',
    note: 'Holds AUDITOR_ROLE. Sees metadata and the event log, never a file.',
  },
  {
    key: 'patient',
    role: 'patient',
    label: 'Patient 101',
    address: '0xaC0b57F1bAc3964f13a1b232fB73B553F24Ec51B',
    note: 'Owns record token #1. Grants and revokes access to their own record.',
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
