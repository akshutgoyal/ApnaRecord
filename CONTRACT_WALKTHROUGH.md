# Contract Walkthrough

A scripted pass through the deployed contract, in the order that makes the argument.
Every call below has been executed against the live deployment; the results quoted are
what the chain returned, not what it ought to return.

```
contract   0xB6e5091f352D3d38933997d78a3585666B4EBaD0
chain      Base Sepolia (84532)      deployed in block 47597163
explorer   https://sepolia.basescan.org/address/0xB6e5091f352D3d38933997d78a3585666B4EBaD0
```

Two ways to run it: through the app (one console per role, the intended path), or call
by call in Remix with the ABI from `contracts/ApnaRecord.sol`. The sequence is the same.

---

## The cast

Five wallets, registered on chain. Nothing about them is hardcoded into the role logic —
the interface reads roles from the contract, which is why switching wallets in MetaMask
is enough to move between consoles.

| Role | Label | Address |
|---|---|---|
| Admin (`DEFAULT_ADMIN_ROLE`) | Platform | `0x436625c20e1f90133c52b6c1728709B295fd82B6` |
| Hospital IT (`HOSPITAL_ROLE`, a facility) | Hospital 101 | `0xc089766ad7B4E2835f1955D7f7122242CdDA978C` |
| Doctor (`MANAGER_ROLE`) | Doctor 101 | `0xF571447d95883AE1b9596bfd8a32D2713a80EA63` |
| Auditor (`AUDITOR_ROLE`) | Auditor 101 | `0x62A4A7C6dA55aBB06012222F97318B53E784636e` |
| Patient (no role) | Patient 101 | `0x194eFBB518Eb356Edb18B7088a7F13629b241348` |

---

## The sequence

### 1 · Establish the cast

Through `/admin/console`, as the admin. Each step is idempotent — `createIdentity` is
create-only and reverts `IdentityExists`, and the console checks before writing, so a
half-seeded cast can be finished rather than restarted.

```
createIdentity(hospital)          -> IdentityCreated
grantRole(HOSPITAL_ROLE, hospital) -> RoleGranted
createFacility(hospital, "City Hospital 101") -> FacilityCreated

createIdentity(doctor)            -> IdentityCreated
grantRole(MANAGER_ROLE, doctor)    -> RoleGranted

createIdentity(auditor)           -> IdentityCreated
grantRole(AUDITOR_ROLE, auditor)   -> RoleGranted

createIdentity(patient)           -> IdentityCreated     (patients hold no role)
```

**Expect:** five `IdentityCreated`, four `RoleGranted`, one `FacilityCreated`.

> **Why the role and the facility are separate.** A wallet holding `HOSPITAL_ROLE` but no
> facility can do nothing — the contract's gate reads `facilities[account]`, not the role.
> That distinction cost an afternoon once; it is deliberately in the walkthrough.

### 2 · Link the patient to the hospital

The link is what makes the facility meaningful, and it needs the patient's own consent.

```
requestPatientLink(hospital, patient)   -> PatientLinkRequested
   (as the patient) approvePatientLink   -> PatientLinked
```

**Expect:** `PatientLinkRequested`, then `PatientLinked`. The `facilityPatient(hospital,
patient)` mapping is now `true`, and `linkedPatients(hospital)` includes the patient.

### 3 · Request the record

As the doctor. `requestRecord` takes **no arguments** — it records that the caller asked
for something, and the admin decides what to issue.

```
requestRecord()                         -> RecordRequested
```

**Expect:** one `RecordRequested`. Nothing else happens: the contract keeps no request
state, so "was this fulfilled?" is inferred from a later mint for the same patient.

### 4 · Mint it

As the admin. This is where the file becomes a record.

```
mintRecord(
  patient,
  0x09a86ac59f0232b3b957b2634ce13d032dc043f934c002b3ba7d23d0e3060eff,
  "sha256:09a86ac59f0232b3b957b2634ce13d032dc043f934c002b3ba7d23d0e3060eff"
)                                       -> RecordMinted, Locked
```

**Three arguments, and none of them is the file.** The digest is `keccak256` of the
*encrypted* bytes; the type (`MRI_SCAN`) is clinical information and stays on the server
row. The token is minted to the patient, not to the hospital that uploaded it.

**Expect:** `RecordMinted` carrying the token id and the digest, plus `Locked`.

```
ownerOf(1)                              -> the patient's address
locked(1)                               -> true
```

### 5 · Read it, with consent

As the patient — the only wallet that can open the window.

```
grantAccess(1, doctor, 3600)            -> AccessGranted
canAccess(1, doctor)                    -> true
```

As the doctor:

```
viewRecord(1)                           -> the cid
```

**Expect:** the cid is returned **only** to a viewer the contract accepts. Reading is a
`view` call — no gas, no trace of who looked.

### 6 · Close the window

As the patient:

```
revokeAccess(1, doctor)                 -> AccessRevoked
canAccess(1, doctor)                    -> false
```

As the doctor, the identical call that worked a moment ago:

```
viewRecord(1)                           -> REVERTS AccessDenied
```

**Expect:** the revert. This is the pair that carries the argument — same call, same
caller, refused, because a mapping changed and nothing was cached.

> **The window also closes by itself.** With `expiresAt` passed, `canAccess` returns
> `false` and `viewRecord` reverts `Expired` without anyone acting. Both outcomes are
> tested; the manual revoke is simply faster to demonstrate.

---

## The gates — what refuses, and why

Three reverts, each reachable from a path in the UI. A contract whose declared errors
cannot be triggered has decorative failures.

| Attempt | Result | Why it matters |
|---|---|---|
| `mintRecord` from a non-admin wallet | reverts `NotAuthorized` | Minting is the admin's, not the uploader's. The clinician who took the scan cannot anchor it. |
| `viewRecord(1)` from the auditor, or anyone without a live window | reverts `AccessDenied` | **Reading is a consent decision, not a role.** Holding `AUDITOR_ROLE` does not open a file; a role is authority to act, not authority to see. |
| `transferFrom` / `safeTransferFrom` by anyone, including the owner | reverts | Records are soulbound (ERC-5192). The transfer path does not exist — not "is blocked", *does not exist*. |

Plus two that answer rather than refuse:

```
verifyRecord(1, correctDigest)          -> true     (a view call — no gas, no account)
verifyRecord(1, alteredDigest)          -> false
auditRecord(1) as the auditor           -> metadata only, never the cid
```

**Verification is the primitive worth showing.** A party who trusts nobody — not the
hospital, not this system — re-hashes a file and compares it to 32 bytes on a public
ledger. `/verify` does exactly this with **no wallet connected**.

---

## What the record lifecycle leaves behind

Every event below has been emitted on the deployment. This is the audit trail, and it is
the same list the auditor console reads.

```
IdentityCreated · IdentityDeactivated · RoleGranted · FacilityCreated
PatientLinkRequested · PatientLinked · PatientUnlinked
RecordRequested · RecordMinted · Locked · RecordRevoked
AccessGranted · AccessRevoked · EmergencyAccessUsed
```

**Why it is events and not a status field.** The contract keeps no per-record state
machine. A record's history *is* its log, which means the deployment does not grow a
mutating table that can disagree with itself — and every step is visible to anyone,
including the patient, on a public explorer.

---

## Honest limits

- **A read leaves no trace.** `viewRecord` is a `view` call. The chain proves who was
  *authorised*, when a window opened and closed, and who opened it. It cannot prove who
  actually looked, and used and unused windows are indistinguishable. Treat the log as a
  record of authority, not of access, and say so before a professor does.
- **Emergency break-glass bypasses consent, deliberately.** One record, one hour,
  `MANAGER_ROLE` only, with a written reason stored permanently in the event. Not
  preventable, but never invisible — the patient's own wallet can watch for
  `EmergencyAccessUsed`.
- **No ownership transfers exist.** Requirement 14 of the problem statement asks for them.
  A medical scan should not be tradeable, so the collection is non-transferable and what
  replaces the transfer log is the full allocation-and-revocation lifecycle. Stated as a
  decision, not discovered as a gap.
- **The type is off-chain.** `RecordMinted` carries the token and the digest and nothing
  else. A category like `MRI_SCAN` is clinical information, and keeping it off a public log
  is the same choice that keeps the file off it.
- **This is a testnet demo with synthetic data.** No real patient data is involved.
