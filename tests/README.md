# Tests

```bash
npm test               # everything: starts a stub chain and a server, runs all suites
npm run test:unit      # the email/code/relay unit suite only — no server, no database
```

`npm test` needs **MongoDB reachable**, because verification codes and grants are stored
there. Nothing else is required: the chain and the mail relay are both stubbed.

```bash
docker run -d -p 27017:27017 mongo:7
npm test
```

Point it elsewhere with `DATABASE_URL`. It defaults to `mongodb://127.0.0.1:27017/apnarecord_test`
— a separate database from the one you develop against, so a test run cannot clear your
working data.

## What each suite covers

| Suite | Needs | Covers |
|---|---|---|
| `unit/email.test.mjs` | nothing | Address normalisation and masking, the keyed hash, code and token crypto, and each relay adapter against a stub HTTP endpoint |
| `integration/contact.test.mjs` | API + MongoDB | Requesting a code, the resend cooldown and rolling hourly cap, cross-instance races for code issuance/verification and grant consumption, the five-guess lockout, and a grant being single-use |
| `integration/wallet.test.mjs` | API + MongoDB + chain | Enrolment requiring **both** proofs, the sealed blob opening only with the recovery code, a spent grant, lookup by address, and concurrent enrolments producing no nonce collision |
| `integration/dripper.test.mjs` | two API instances + MongoDB + stub chain | Shared nonce ordering and contiguity, exact signed-transaction recovery after a rejected broadcast, and receipt recovery after an accepted transaction returns a bad hash |

## Three assertions worth knowing about, because they are easy to weaken by accident

**A rejected relay send must throw.** `unit/email.test.mjs` stands up a stub endpoint that
returns 500 and asserts the send throws. A sender that swallows the failure looks identical
to a slow inbox, and the user waits for an email that will never arrive.

**The mock chain checks the *sender's* nonce.** An earlier version checked the recipient's,
which made the collision assertion pass no matter what the dripper did. If you touch
`support/mock-chain.mjs`, keep it checking `tx.from`.

**The replay test reuses the request body byte for byte.** Re-stamping the timestamp
invalidates the signature, so the key check fires first and the grant check is never
reached — the test passes without testing what it claims to. Same trap in the phone-era
suite; it is worth re-reading any assertion about ordering twice.

## Running a suite on its own

Each suite is a plain script, so you can run one directly against a server you already have
up:

```bash
CONTACT_RESEND_COOLDOWN_MS=2000 CONTACT_MAX_PER_IP=500 node server/src/index.js
node tests/integration/contact.test.mjs
```

The cooldown and the per-IP cap have to be raised, or the suite cannot request a second code
for the same address inside one run. Production leaves both at their defaults.
