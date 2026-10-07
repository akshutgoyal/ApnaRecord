# ApnaRecord codebase review

Initial review: 7 October 2026, against commit `968dca7`.

This review covers the Solidity contracts, API authorization and storage, enrolment and recovery, browser signing and encryption, indexing, dashboards, deployment configuration, and existing tests. Findings marked “reproduced” were demonstrated locally; others follow from the referenced code paths. No production service was probed.

Follow-up on 7 October 2026: the off-chain metadata exposure in finding 1 was addressed in the working tree. Anonymous dashboards now return aggregate chain facts only; other viewers receive subject-scoped rows, facility access is checked against current chain state, and public record audit/history/identity routes no longer expose unscoped off-chain fields. This follow-up was not included in the original test run; other findings remain open.

## Assessment

The project has a coherent core idea: immutable record ownership and ciphertext integrity on-chain, with sensitive content off-chain. The Solidity ownership, soulbound transfer restriction, patient link handshake, and ordinary consent checks are reasonably small and understandable. The most serious problems occur where the browser, server, and contracts disagree about addresses, signatures, and authorization.

The current implementation is a prototype that needs security and integration repairs before holding real patient data. Passing contract tests does not establish the safety of the complete application: several locally reproduced failures sit outside those tests.

## Architecture and actual trust model

| Layer | Actual responsibility |
|---|---|
| `ApnaRecord.sol` | Roles, identities, facility links, soulbound ownership, ciphertext hashes, timed consent, unrestricted manager emergency grants, burns |
| `ApnaRecordAccount.sol` | Immutable owner key, allowlisted internal calls, EIP-1271 signature validation |
| React client | Generates keys and recovery codes, wraps device keys, encrypts records, signs API messages, submits transactions |
| Express API | Verifies readers, checks chain consent, stores clinical metadata, deploys accounts, distributes test ETH, unwraps and releases record keys |
| MongoDB | Enrolment keystores, verified email bindings, profiles, request contents, directory names, sessions, replay/rate-limit state, chain mirrors |
| Disk or S3/R2 | Encrypted documents and content keys wrapped under the server master key |

The server is a trusted key custodian. It receives raw content keys on upload and can unwrap them using `MASTER_KEY` later. Browser encryption protects stored blobs from a storage-only compromise; it does not prevent the running server or an operator with the master key and blobs from decrypting records. Consent expiry stops future API releases, but cannot invalidate a key or plaintext a reader already obtained.

MongoDB is partly a chain cache and partly an essential source of data. Names, profiles, request contents, email bindings, and sealed wallet keys cannot be rebuilt from chain logs. Backup and restoration requirements should reflect that distinction.

## Findings, in priority order

### 1. High — public API responses expose clinical metadata and real names

References: `server/src/controllers/statsController.js:91`, `:104`, `:331`, `:445`, `:565`; `server/src/controllers/chainController.js:49`, `:68`, `:201`, `:301`; `server/src/controllers/recordController.js:124`; `server/src/routes/apiRoutes.js`.

`/stats` only removes properties matching `label` or `*Label`. Anonymous responses retain `displayName`, `patientName`, `recordType`, request patient associations, and other off-chain fields. A signed caller receives the entire unredacted platform payload, regardless of patient entitlement. Supplying a facility query filters by a chosen facility but does not establish that the viewer represents it.

Other bypasses exist: `/chain/permissions/:address` returns the off-chain identity label without authentication; `/chain/records/:tokenId/history` returns record type and actor labels; `/audit/:tokenId` returns record type publicly. `/chain/identities` reveals every label to any valid wallet. The chain fallback of `/records` also lacks an off-chain field filter, although record types normally remain empty when the database is unavailable.

**Evidence:** Executing the dashboard's actual redaction function on representative data retained both a real name and `MRI_SCAN`, while only the `label` field became null. The other endpoint exposures are established by route and response inspection.

**Repair:** Define explicit public response schemas containing only public facts. Apply subject and role authorization to every off-chain join, including aggregates and history endpoints. Authentication alone is insufficient. Test anonymous, unrelated wallet, patient, consented clinician, discharged facility, auditor, and admin responses for forbidden fields.

### 2. High — account funding does not pay for the owner's transactions

References: `server/src/controllers/walletController.js:309`, `:559`; `client/src/lib/gas.js:59`; `client/src/chain.jsx:345`; `client/src/lib/session.js:417`.

Enrolment and top-ups fund the account contract. The client then constructs a contract with the owner's ordinary `Wallet` signer and calls `account.execute`. The outer transaction is sent and paid for by the owner EOA. The account becomes `msg.sender` only for the internal call to ApnaRecord; that does not make it the gas payer. A fresh owner key has zero ETH.

**Evidence, reproduced on Ganache:** Account balance `10000000000000000` wei; owner balance `0`; owner-signed `execute` rejected with `INSUFFICIENT_FUNDS`.

**Repair:** For the existing ordinary transaction design, fund and check the owner EOA, while retaining the account as the record subject. Alternatively implement a deliberate relayed transaction/account abstraction design with its own authenticated execution protocol. Correct the comments that say the account pays for these outer transactions. Ethereum's [gas documentation](https://ethereum.org/developers/docs/gas/) explains sender fee deductions.

### 3. High — signatures do not authenticate several mutable write payloads

References: `server/src/controllers/profileController.js:18`, `:118`, `:169`; `server/src/controllers/walletController.js:89`, `:505`; `server/src/controllers/recordController.js:26`, `:371`.

The profile signature covers only address and timestamp. A captured valid request signature can authorize different allergies, blood group, date of birth, and emergency contacts during the freshness window. DELETE accepts the same “profile update” signature, so it can also erase the profile. The handlers have no one-use replay claim.

Recovery rotation signs only account address and timestamp, excluding the replacement sealed key, salt, and KDF parameters. A captured rotation authorization can therefore replace the recovery blob with different ciphertext. The upload signature covers token, patient, and ciphertext digest, but excludes `contentKey`, `plainHash`, record type, filename, MIME type, and CID. Reusing an eligible upload authorization can overwrite the digest-addressed wrapped key with a wrong key or change the plaintext verification claim. These attacks require a valid captured authorization; unrelated callers cannot forge the signature from scratch.

**Evidence, reproduced against the real profile handlers and an isolated MongoDB:** One signature successfully stored two different allergy values, then successfully deleted the profile.

**Repair:** Sign operation-specific typed messages with chain/deployment domain, canonical payload digest, nonce, and deadline. Include all mutable security-relevant values, and atomically consume the nonce. Use a distinct delete operation. Validate the content key against the encrypted payload before storing it, and control replacement of an existing wrapped key.

### 4. High — OTP and contact grants are not single-use under concurrency

References: `server/src/services/otp.js:126`, `:190`; `server/src/lib/rateLimit.js:31`.

`verifyCode` reads an unconsumed OTP and subsequently saves `consumedAt`. Multiple requests can read the same state before any save completes and each issue a new grant. `consumeGrant` has the same read-then-save race. Wrong-guess counting also mutates an independently loaded document, allowing concurrent increments to overwrite each other. The shared rate limiter counts and then inserts, which can overshoot under concurrent requests.

**Evidence, reproduced with the real service and isolated MongoDB:** Ten simultaneous calls successfully consumed the same contact grant. Ten simultaneous verifications of one correct OTP issued ten grants.

**Repair:** Claim unconsumed, unexpired grants using one conditional `findOneAndUpdate`. Make OTP attempts and successful consumption atomic, with grant issuance handled consistently after the claim. Test simultaneous successful verifications, grant consumption, and incorrect guesses, across two instances.

### 5. High — existing cross-instance dripper tests fail on nonce reuse

References: `server/src/services/dripper.js:102`, `:192`; `tests/integration/dripper.test.mjs`.

The full suite failed three dripper assertions: nonce reuse, nonce uniqueness, and contiguity. The mock chain reported reuse of nonces `10`, `15`, `27`, and `28` during this run.

`reconcileNonce` treats a pending transaction count below the database counter as grounds to rewind when `inFlight` reaches zero. That is not proof that a transaction was never broadcast. The provider/node may report a stale pending count, and another instance may broadcast and settle after the reconciler's observation. Its update uses `nextNonce > onChain` instead of comparing the exact observed counter/version, so it can rewind newer completed claims as well. Ethers read caching is another possible source of stale observations. These are code-level failure mechanisms; the relative contribution of each needs targeted instrumentation.

**Repair:** Use a durable per-nonce transaction/outbox state and safe replacement/retry rules rather than rewinding from a single pending-count observation. Serialize reconciliation with claims across processes and use conditional version checks. Cover cached/stale RPC answers, delayed broadcast, crashes, and ambiguous send errors. Do not deploy multiple funding instances with the current behavior.

### 6. High — the account address is lost in generic API authentication and write checks

References: `client/src/services/api.js:67`, `:95`; `client/src/lib/session.js:417`; `server/src/controllers/profileController.js:41`; `server/src/controllers/recordController.js:301`; `server/src/controllers/directoryController.js:184`, `:298`.

The local signer identifies the owner EOA, while records, roles, and profiles belong to the account contract. `authHeaders` creates a session for `signer.getAddress()`, so generic profile, link, and scoped metadata reads authenticate as the EOA rather than the patient's account. Subject authorization then sees an unrelated viewer.

Profile writes and existing-record repairs require a recovered EOA signature to equal the account address, which is impossible for an ordinary signature. Directory and staged-upload role checks similarly ask for roles on the recovered owner rather than the acting account. A newly enrolled staff account granted a role can execute on-chain once gas is fixed but its corresponding API write is still rejected. The dedicated file read proof already handles account owners, showing that support is inconsistent across flows.

**Repair:** Carry the acting account separately from its signer through all client APIs. Validate EOAs directly and contracts through a consistent contract-signature mechanism. The account already exposes the [EIP-1271 interface](https://eips.ethereum.org/EIPS/eip-1271); use it for contract authorization instead of duplicating ad hoc owner comparisons. Check roles on the authenticated acting account.

### 7. High — uploads race on the predicted next token ID

References: `client/src/pages/Admin.jsx:400`, `:423`, `:439`; `server/src/controllers/recordController.js:334`, `:374`; `server/src/services/indexer.js:123`.

The browser reads `nextTokenId`, uploads a database row keyed by that ID, and separately submits `mintRecord`, which assigns whatever ID is next when it executes. Two issuers can stage different records for the same ID. A later upload overwrites the first row, and the later mint receives another ID. The indexer corrects patient and ciphertext hash but does not reconstruct the original file metadata or correct a record type copied from an overwritten row.

Cancelled or failed mints also leave staged rows in the same collection served as the record index. Thus an upload can look like a live record before any mint exists.

**Repair:** Stage by a unique upload ID/digest rather than a predicted token ID. After confirmation, bind metadata to the actual `RecordMinted` receipt and verify digest, recipient, issuer, contract, and chain. Serve confirmed records separately from staged uploads and clean up abandoned stages.

### 8. High — facility metadata entitlement can survive discharge or role removal

References: `server/src/middleware/requireWallet.js:149`, `:169`; `server/src/lib/facilityScope.js:27`; `server/src/services/indexer.js:140`; `contracts/ApnaRecord.sol:192`, `:340`.

List entitlement reads facility links from MongoDB, while the single-subject guard checks chain state directly. Between discharge and index refresh, list/profile routes can release off-chain fields that the current chain link no longer authorizes. The indexer folds only the newest 500 events; an unlink omitted from that window during downtime can leave the cached link permanently stale.

Facility entitlement uses `isFacility`, without requiring the current hospital role. Solidity registration and minting also use the persistent `facilities` flag rather than `HOSPITAL_ROLE`. Revoking that role does not retire all facility privileges, and there is no facility retirement function.

**Repair:** Check current chain links and relevant roles before disclosing protected subject data. Build the index with a persisted cursor, complete catch-up, and reorg handling. Define explicit facility suspension/retirement behavior and enforce it consistently in Solidity and the API.

### 9. Medium — request metadata is not bound to its actual chain anchor

References: `server/src/controllers/directoryController.js:272`, `:298`, `:308`.

`recordRequest` verifies that the signer currently has manager privileges, but not that the named `requestId` exists or that its `RecordRequested` event names that signer. A manager can prepopulate another manager's future ID or claim an already emitted ID before its true requester writes metadata. The existing-row guard then rejects the genuine requester. Identity directory writes similarly check current privileges without confirming the corresponding chain identity and placement.

**Repair:** Bind off-chain writes to confirmed receipts/events and verify the expected actor and anchor. Make actor assignment immutable with atomic create or conditional updates. Distinguish staging from confirmed directory data.

### 10. Medium — wallet identity status decodes the obsolete struct shape

Reference: `server/src/controllers/walletController.js:36`.

`call('identities')` returns `(createdAt, active, facility)`. `onChainIdentity` destructures the first result into `identity`, then accesses `identity[2]` and `identity[0]`. Those accesses are against the timestamp scalar, not the result tuple. Successfully registered wallets are reported as unregistered and the returned label is meaningless.

**Repair:** Use the decoded result directly and read `active` or index 1. Load labels from the off-chain directory. The pending-registration controller already demonstrates the corrected tuple handling.

## Design and operational limitations requiring explicit decisions

- **Emergency access is global and repeatable.** Any manager can grant any viewer access to any live token for an hour, repeatedly, and override a patient revocation. No justification is persisted by the current Doctor flow despite the Solidity comment saying it is stored in the database. The event records the recipient but not the authorizing manager; for account execution, transaction sender attribution identifies the owner EOA rather than the acting account. Define the intended scope, approval, justification, attribution, and review process.
- **Identity retirement is partial.** `deactivateIdentity` does not revoke roles or existing consent. A retired manager with its role intact can continue emergency grants. Decide which abilities retirement must remove and test each one.
- **The owner key remains an ordinary unrestricted EOA key.** The account restricts calls made through that account; it cannot restrict transactions or signatures made directly with the leaked owner key on other addresses/chains. Comments claiming the key itself is bounded overstate the protection.
- **Burning is not crypto-shredding.** `revokeRecord` burns an NFT and deletes contract metadata. No storage/key deletion path destroys the wrapped key or blob. Claims in profile comments/README about crypto-shredding need either implementation with retention/backup semantics or correction.
- **Daily spend caps are not reservations.** Separate instances can read the same remaining budget before either records a spend. Account deployment costs are also outside the drip cap, and repeated empty-account rebinds trigger new paid deployments. Protect deployment spending as well as transfers, with atomic budget reservations.
- **Verification has two trust levels.** Ciphertext matching is chain-backed. Plaintext matching is server-backed and its digest is mutable through the upload path. The server response distinguishes them, which is useful, but the stronger claim must not be implied for the second result.
- **Read replay protection weakens during outages.** `claimOnce` allows reads when MongoDB is unavailable. Also, a proof up to five minutes in the future is accepted while its nonce row lasts only five minutes from consumption; after TTL deletion it can still be fresh. Store nonce expiry through the full accepted validity interval, or reject future timestamps beyond small clock skew.
- **Scaling is bounded by full scans.** `getAllLogs` repeatedly scans from deployment, `tokensOf` loops over all token IDs, dashboard consent computation checks records × candidate viewers, and index/database list endpoints load whole collections. Implement incremental indexing, pagination, and targeted queries before growing past demo scale. The 500/1000-event truncation also affects completeness of historical views.
- **Documentation needs reconciliation.** Several comments describe obsolete schemas, say the server has no signing key despite its deployment/funding key, or describe MongoDB as entirely rebuildable. Treat comments as assertions to check against code, especially security claims.

## Validation

The frontend production build succeeded. Vite reported that mixed static/dynamic imports prevent the API module from becoming a separate chunk.

The full suite ran with an isolated disposable `mongo:7` container and dedicated API/RPC ports, without connecting to the configured application database or storage bucket:

```bash
DATABASE_URL=mongodb://127.0.0.1:27028/apnarecord_test \
API_PORT=15200 API_PORT_2=15201 CHAIN_PORT=18545 npm test
```

Results:

| Suite | Passed | Failed |
|---|---:|---:|
| Account contract | 23 | 0 |
| ApnaRecord contract | 58 | 0 |
| Email unit | 41 | 0 |
| Directory unit | 15 | 0 |
| Indexer unit | 9 | 0 |
| Contact integration | 22 | 0 |
| Wallet integration | 33 | 0 |
| Binding integration | 17 | 0 |
| Hardening integration | 28 | 0 |
| Directory integration | 19 | 0 |
| Dripper across instances | 11 | 3 |
| **Total** | **276** | **3** |

Ganache used its JavaScript fallback because its native µWS binary does not match the installed Node version; both contract suites still completed successfully. An initial standalone email run without `NODE_ENV=test` hit the mock-provider environment guard; the full runner pins the correct environment and that suite passed.

Additional targeted local checks reproduced the unfunded-owner gas failure, profile payload substitution and cross-operation signature replay, incomplete anonymous stats redaction, concurrent grant reuse, and concurrent OTP grant issuance. Temporary proof databases were removed after those checks. Existing HTTP integration suites use a stub chain, so they cannot prove an enrolled zero-balance owner can send real account transactions.

## Recommended repair order

1. Close public metadata/name leaks and centralize subject authorization.
2. Fix the gas payer and account-versus-owner identity consistently across reads and writes.
3. Bind signatures to exact operations/payloads and implement atomic OTP, grant, and nonce claims.
4. Repair dripper nonce reconciliation and enforce shared spending/deployment budgets.
5. Separate staged uploads from confirmed records; bind metadata to transaction receipts.
6. Make facility authorization current, index incrementally, and define retirement/emergency policy.
7. Add a real-EVM end-to-end enrol → register → link → mint → grant → read → revoke test and a negative authorization matrix for every metadata route.

After these changes, review recovery, key custody, erasure, and operational backup requirements before making production privacy guarantees. This assessment concerns the local source and observed local behavior; deployed bytecode equivalence, live configuration, browser UX, and a formal cryptographic audit remain unverified.
