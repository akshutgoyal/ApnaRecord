# ApnaRecord repair queue

Ordered from the security and correctness findings in [CODEBASE_REVIEW.md](CODEBASE_REVIEW.md). Each item should be completed, reviewed, and committed before starting the next.

## Open fixes

- [x] Restrict off-chain clinical metadata and identity labels to entitled viewers.
- [x] Fund the owner EOA that submits account transactions, and check its balance before requesting a top-up.
- [x] Carry the acting account separately from its owner signer through API authentication, profile writes, directory actions, and role checks; support contract signatures consistently.
- [x] Bind profile, recovery, and upload signatures to operation-specific, chain/deployment-bound payloads, deadlines, and one-use nonces; authenticate encrypted bytes with their content key and prevent key replacement.
- [x] Make OTP verification, contact-grant consumption, and related attempt accounting atomic under concurrent requests.
- [x] Replace unsafe dripper nonce rewinds with durable cross-instance transaction state and exact-byte retry behavior.
- [x] Stage uploads under unique identifiers and bind metadata to the confirmed mint receipt; keep unconfirmed uploads out of record listings.
- [ ] Authorize facility data against current chain links and roles, and make index catch-up complete and reorg-aware.
- [ ] Bind request and identity directory metadata to confirmed chain events and immutable actors.
- [ ] Decode the wallet identity tuple using the current contract ABI.
- [ ] Define and enforce facility retirement, identity deactivation, and emergency-access scope and attribution.
- [ ] Reserve dripper and deployment budgets atomically across service instances.
- [ ] Preserve read-proof replay protection during database outages and for the full accepted timestamp window.
- [ ] Correct verification, key-erasure, key-custody, and backup claims to match implemented guarantees; implement any explicitly chosen erasure policy.
- [ ] Replace full-history scans and unbounded list queries with cursor-based indexing, pagination, and targeted queries.
- [ ] Add end-to-end coverage for enrolment through revocation and a negative authorization matrix for metadata routes.

## Progress

- Initial codebase review completed on 7 October 2026; see [CODEBASE_REVIEW.md](CODEBASE_REVIEW.md) for evidence, code references, and limitations.
- Finding 1: scoped clinical metadata and identity labels to entitled viewers; committed.
- Finding 2: enrolment and top-ups fund the transaction-paying owner EOA; the account remains the enrolled identity.
- Queue item 3: API sessions and authorization now use the acting account; signed writes validate EIP-1271 account authorization and check roles against that account.
- Queue item 4: signed profile, recovery, and upload writes bind the exact operation and stored data to the configured chain and contract, expire within five minutes, and atomically consume a shared nonce; uploads also validate their AES-GCM key and cannot replace a stored key with a different one.
- Queue item 5: OTP consumption and wrong-attempt increments use conditional atomic updates, grants are consumed with a single-use claim, and rate limits use a shared atomic rolling-window row. Added cross-instance concurrency and per-contact cap coverage.
- Queue item 6: a shared lease serializes dripper transactions, durable intents and signed bytes survive process failures, and uncertain sends resume by inspecting or rebroadcasting the same transaction. Old ambiguous counter state is refused instead of rewound.
- Queue item 7: pre-mint uploads use random IDs and remain outside the record cache until the successful receipt, exact mint calldata, issuer, patient, digest, contract, and configured chain are verified. The upload ID is carried in the private CID field, legacy predicted-ID metadata stays hidden, and browser-side pending references support confirmation retry after reload.
- Remaining fixes are to be handled in queue order. Update this file as each fix is committed.
