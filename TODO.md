# ApnaRecord repair queue

Ordered from the security and correctness findings in [CODEBASE_REVIEW.md](CODEBASE_REVIEW.md). Each item should be completed, reviewed, and committed before starting the next.

## Open fixes

- [x] Restrict off-chain clinical metadata and identity labels to entitled viewers. The API response and authorization changes are ready in the working tree; commit them with this queue.
- [ ] Fund the owner EOA that submits account transactions, and check its balance before requesting a top-up.
- [ ] Carry the acting account separately from its owner signer through API authentication, profile writes, directory actions, and role checks; support contract signatures consistently.
- [ ] Bind profile, recovery, and upload signatures to operation-specific payloads, deadlines, and one-use nonces.
- [ ] Make OTP verification, contact-grant consumption, and related attempt accounting atomic under concurrent requests.
- [ ] Replace unsafe dripper nonce rewinds with durable cross-instance transaction state and safe retry/replacement behavior.
- [ ] Stage uploads under unique identifiers and bind metadata to the confirmed mint receipt; keep unconfirmed uploads out of record listings.
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
- Fixes are to be handled in queue order. Update this file as each fix is committed.
