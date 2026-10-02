# ApnaRecord

> Your health records, owned by you and no one else.

Patient-owned medical records, verifiable by anyone, instantly.

**Login is a wallet. A record is a soulbound token. Permission is a smart contract.**

Live contract (Base Sepolia): [`0xB6e5091f352D3d38933997d78a3585666B4EBaD0`](https://sepolia.basescan.org/address/0xB6e5091f352D3d38933997d78a3585666B4EBaD0) · deploy block `47597163`

---

## The problem

Medical records sit fragmented across paper files and private hospital databases.
They are easy to tamper with, easy to lose in a transfer, and impossible to verify
without trusting whoever happens to be holding them. Consent exists as policy rather
than as proof, and the patient — whose data it is — holds nothing.

## The solution, in one line

Three substitutions do all the work:

| Ordinary system | ApnaRecord |
|---|---|
| Username and password | A wallet address — the key *is* the identity |
| A row in a database | A soulbound token owned by the patient's wallet |
| A permission flag | A smart contract that re-checks every call |

The fourth claim is why this is not "just a database": **anyone can verify a record
for free, without trusting us.**

---

## What is actually built

| | |
|---|---|
| **Contract** | Solidity 0.8.24, OpenZeppelin ERC-721 + AccessControl, ERC-5192 soulbound. Deployed and live on Base Sepolia |
| **Frontend** | React 18 + Vite 6 + Tailwind 3 + ethers v6 — one console per role |
| **Backend** | Express 4 + Mongoose 8 — serves ciphertext, indexes the chain |
| **Storage** | Encrypted blobs on disk, behind an interface that IPFS drops into |

### What the dashboards do

Each role's dashboard reads chain state directly and is built to be worked in, not just
looked at:

- **Drill down from any row.** Clicking a record or an identity opens a side panel with
  its full context — ownership, live consent windows, and the record's complete event
  timeline (`GET /api/chain/records/:tokenId/history`), oldest first with the actor named
  on every line.
- **Search, filter, sort and page every table.** Sorting is a three-state cycle
  (ascending → descending → off, so there is a way back to the chain's own ordering), and
  filtering always returns you to page one.
- **The event log is filtered and paged on the server** (`/api/chain/events?name=&actor=&search=&fromBlock=&toBlock=&offset=&limit=`),
  because it is the one dataset that grows without bound.
- **An expiry watchlist.** Windows closing within 24 hours are surfaced on the patient,
  doctor and admin dashboards. Nobody has to act on them — the contract closes each window
  on time by itself — but knowing which ones are about to lapse is the difference between
  "17 grants exist" and "two are about to close on you".
- **CSV export of exactly what you filtered.** Generated client-side, so an export never
  becomes an unauthorised data egress, and a filtered view exports what it shows.
- **Every dashboard dates itself**, and says whether the numbers came from the chain or
  from the server's 60-second cache. **Refresh from chain** bypasses the cache on purpose.
- **One panel failing does not blank the page.** Each panel has its own error boundary
  with a retry, because reading a contract means several independent RPC calls.

**Reading a report.** A clinician opens a report from the dashboard — from the "records you
may read now" list, or from a token chip on a patient's row — and it is fetched through the
consent gate and decrypted in the browser. The reader distinguishes the ways a read can fail
instead of collapsing them into "access denied":

| What the contract says | What the reader tells you |
|---|---|
| `AccessDenied` | No window is open to you. Ask the patient to open one. |
| `Expired` | A window existed and lapsed. Nothing was revoked and nothing is broken. |
| `Locked` | The record is frozen under an emergency lock. |
| `BlobMissing` | The chain anchors this record, but this server does not hold its bytes. |
| Passed the gate, no readable bytes | The record is not text; the digest can still be verified. |

**Tokens, stated plainly.** Every surface labels a record as `#3 · MRI scan · issued 14 Feb ·
ordered by Cardiology`, and patient rows list the tokens they hold. "Record #3" is not
something a clinician can act on; a type, a date and a requester is.

**The admin's work queue.** Requests that were made and never issued appear as a queue with a
one-click hand-off to the mint form, pre-filled from the request event.

> **Derived, not stored.** The contract keeps no request state — `requestRecord` only emits an
> event, and `RecordMinted` does not echo the request it answers. So "fulfilled" is inferred:
> a request is open when no later mint exists for the same patient and record type. The UI says
> so wherever it shows it. Ordering provenance ("ordered by") uses the same inference and reads
> `—` when there is genuinely no preceding request, rather than guessing at one.

**What the audit log cannot prove.** An auditor screen is only useful if it is honest about its
blind spot, so the auditor dashboard states it up front: the chain proves **who was authorised**
to read a record, when the window opened and closed, who opened it, and every state change since.
It does **not** prove who actually looked — a read is a `view` call that leaves no trace, and a
refused read leaves none either. Used and unused windows are indistinguishable. Treat it as a
record of authority, not of access.

---

## Creating an account

There is no MetaMask step, and no seed phrase. A patient is walked through four things and
never sees a wallet:

1. **They verify an email address.** One code, and the address is bound to the account. This is
   not decoration: it is what lets them find their wallet again on a new device. It is also
   *only* that — an address can locate a wallet and can never open one, which is why an
   inbox takeover here ends with an attacker holding ciphertext instead of a medical history.
2. **A key is generated in the browser.** Not on the server. It is created with
   `crypto.getRandomValues`, and it exists in that tab and nowhere else until step 3.
3. **It is locked behind a recovery code** — 20 characters in four groups of five, from a
   Crockford base32 alphabet so that `O/0` and `I/1/L` cannot be confused. The code is
   stretched with PBKDF2-SHA256 at 600,000 iterations, and the resulting key encrypts the
   private key with AES-GCM. Only the ciphertext is sent.
4. **The user writes the code on paper.** The screen shows it once, offers a print and a
   download, and requires an explicit confirmation before continuing.

The server then holds a sealed blob, a salt, an address, and a **hash** of the email address.
It cannot open the blob and it does not have the address:

```text
email      ──HMAC(MASTER_KEY)──>  stored, for lookup only
           └─ masked as a•••@gmail.com for display; the address is never persisted

recovery   ──PBKDF2(600k)──> wrapping key ──AES-GCM──> sealed blob ──> server
code       └── never transmitted. Not to the server, not to us, not anywhere.
```

Any endpoint that could sign as a user is absent by construction, which is the point. Anyone
who exfiltrates the whole database gets ciphertext, addresses, and hashes.

### Email addresses, and what they are not

An email address identifies a *channel to reach someone*, not a person. It is free to
create, free to share, and abandoned without ceremony. So the design gives it exactly one
job and forbids it the other:

| A verified address **can** | A verified address **cannot** |
|---|---|
| Locate the wallets bound to it | Open any of them |
| Trigger a fresh code | Recover a lost recovery code |
| Reach the user for a future notice | Authorise a read, a write, or a consent |

That separation is the whole reason the identity provider can be weak without weakening the
product. It also means the honest limit is stated plainly rather than discovered: **if a
patient loses both the address and the recovery code, the wallet is gone**, and because the
records are soulbound they cannot be moved. A second address, a second code, or a guardian
quorum is the designed fix and is not built.

> **The trade-off, stated plainly.** Without an extension there is no OS-level confirmation
> between the page and the key, so anything that can run script on this origin can read the
> key while a session is open. The session is kept in `sessionStorage` — it survives a refresh
> and dies with the tab — and the key is dropped entirely by **Lock this wallet**. The proper
> fix is a passkey-signed smart account, which removes the stored key altogether; `getSigner()`
> is the single seam it would need.

**Why the wallet is not in the database as a key.** Adding one field for a private key, a
recovery code, or a derived wrapping key would silently convert this into a custodian — the
hospital could then consent on a patient's behalf, and the central claim would become false
rather than merely imperfect. The schema says so at the point where someone would be tempted.

**Recovery, and its limits.** The recovery code opens the wallet on any device. It cannot be
reset, and there is no escrow. That is a real risk for the people this is built for, and the
designed answer is a second factor plus a timelock — a printed second code, a second passkey,
or guardians with a veto window — none of which is built yet. Until it is, losing the code
loses the wallet, and because the records are soulbound they cannot be moved to a new address.


Three stores, each doing the one job it is best at. Nothing important depends on
any single one of them agreeing with the others.

| Store | Holds | Why |
|---|---|---|
| **Blockchain** | Owner, roles, the 32-byte record digest, consent windows, every event | Truth. Public, immutable, tamper-proof. If anything disagrees with the chain, the chain wins. |
| **Server (disk)** | The encrypted file and its sealed content key | The file itself has no business on a ledger. A 500 MB scan costs the same on-chain as a text file. |
| **MongoDB** | A browse index of identities, records, events, links and requests, plus patient-chosen display names | Speed only — except the names, labels, links and request contents, which live ONLY here. The chain-derived rows can be dropped and rebuilt from logs at any time; the directory rows cannot. |

> **Mongo answers quickly. The chain answers truthfully.**

### What never happens

- The server **never holds a signing key**. Every state change is signed in the user's
  own wallet. There is nothing on the server worth stealing that would let anyone mint.
- The record **never leaves the browser in plaintext**. It is encrypted with a
  per-record AES-256-GCM key generated in the tab; the server receives ciphertext.
- A permission is **never cached**. Every read runs `eth_call` against the contract.

---

## Enforced gates

Four things the contract refuses, whatever the interface allows:

| Gate | What happens |
|---|---|
| **Admin-only minting** | A non-admin `mintRecord` reverts with the AccessControl missing-role error. |
| **Soulbound** | Even the owner cannot transfer a record. The code path does not exist. |
| **Consent expiry** | After the window closes, the read itself reverts. |
| **Gated audit** | A non-auditor is refused, and the auditor never receives the file location. |

Plus **free, permissionless verification**: re-hash the file, compare with the on-chain
digest, and get a verdict. It is a `view` call — no gas, no account, no wallet, no trust
in us. Try it on `/verify` with no wallet connected at all.

### The read gate asks two questions

The contract answers "may this viewer read this record?". It cannot answer "is the caller
actually this viewer?" — and for a while the server didn't either:

```text
  BEFORE                                 AFTER
  GET …file?viewer=0xF2…                 GET …file?viewer=0xF2…  + signature headers
        │                                      │
        ├─ eth_call {from: 0xF2…} ──> OK       ├─ recover the signer, require it == 0xF2…
        └─ returns the record                  ├─ then eth_call {from: 0xF2…} ──> OK
                                               └─ then return the record
```

Since a consented address is public on-chain, naming one was the whole of the attack: read
`0xF2…` off Etherscan, put it in the query string, receive their records. The gate was
enforceable against addresses and useless against people.

A read now carries an **EIP-712 signature** over `{tokenId, viewer, issuedAt, nonce}` —
bound to the record, the reader, the contract and the chain. Issued-at is valid for five
minutes and the nonce is single-use, so a captured signature is not a bearer token. Only
once the signer matches the claimed viewer does the contract get asked. Note that **even the
record's owner signs**: there is no "but they own it" shortcut, because that shortcut is
where the hole lived.

**Gas is nobody's problem.** Wallets are funded at enrolment and top themselves up before a
write when they run low, so no user ever acquires test ETH. The float's health — balance,
and how many enrolments it still covers — is on the startup banner and at `GET /api/dripper`,
because an emptied float is the one failure that looks like success.

---

## Design system

Two shells, one palette. Warm and institutional, deliberately not clinical white.

| Token | Value | Use |
|---|---|---|
| `ink` | `#0C2431` | The public site — hero and marketing surfaces |
| `paper` | `#FAF6EE` | The product — every dashboard background |
| `parchment` | `#F5EFE2` | Text on ink |
| `peacock` | `#0E6E62` | Primary actions, active states, "active" status |
| `marigold` | `#D99A00` | Accent, ~10% of a screen: CTAs on ink, timers, live dots |
| `success` | `#15803D` | Healthy, readable, granted |
| `warn` | `#B45309` | Attention without failure |
| `error` | `#B42318` | Denied, expired, revoked, destructive |

Marigold means exactly one thing — *time-bound / attention* — and never means "error"
and never means "primary". Teal against amber also stays distinguishable for the most
common forms of colour blindness, which is why that pair was chosen over the obvious
saffron-and-green.

A closed set of six status tokens (`active`, `pending`, `expiring`, `expired`,
`denied`, `revoked`) is used identically on the landing page and in all four consoles,
always as icon + text + tint — never as colour alone.

---

## Running it

### Prerequisites

- **Node.js 18+** and **npm** (check with `node --version`).
- **No wallet is required.** Accounts are created in the browser — no extension, no seed
  phrase, no test ETH to find. MetaMask (or any injected wallet) still works if you already
  have one, and is useful for exercising the app as an administrator, but nothing depends
  on it.
- **MongoDB is optional for reading the chain, and required for creating accounts.** The API
  boots with no database and rebuilds record metadata from chain logs, so dashboards work
  without it — but a sealed key has to be *stored* somewhere, so enrolment and unlock return
  a clear `503` until a database is configured. A free Atlas M0 cluster is enough.
- **A funded dripper wallet** if you want new accounts to be able to write. Optional: without
  it, wallets are still created, they just have no gas.

### 1. Install

```bash
git clone <your-repo-url> apnarecord
cd apnarecord
npm install
```

### 2. Configure the server

```bash
cp server/.env.example server/.env
```

Generate the key that seals each record's content key at rest:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then set the two required values in `server/.env`:

```env
MASTER_KEY=paste-the-generated-64-hex-here
DATABASE_URL=          # optional — blank means "rebuild from the chain"
```

Chain values (`RPC_URL`, `CONTRACT_ADDRESS`, `CONTRACT_DEPLOY_BLOCK`) already
point at the deployed contract — leave them unless you deploy your own.

**Optional: the gas float.** This is what lets a new account act without anyone acquiring
test ETH. Generate a wallet and add it to `server/.env`:

```bash
npm run dripper:new          # prints an address and a private key
```

```env
DRIPPER_PRIVATE_KEY=paste-the-key-here
```

Then fund the **address** it printed — by hand, and once. Nothing in the codebase does this
for you, and that is a decision rather than a gap. Replenishing automatically means mining
proof-of-work on the application server to satisfy a faucet: a core burned for minutes at a
time, and a float that depends on a third party being reachable. A manual top-up costs
nothing, and test ETH is free.

**One ETH covers about 100 new accounts**, because the float pays for the drip *and* the
account deployment that goes with it. Check what is left at any time — it is also printed on
the startup banner:

```bash
curl localhost:5000/api/dripper
```

The startup banner reports the balance and how many enrolments it can afford, and warns
loudly below `DRIP_LOW_WATER`. That warning exists because an emptied float is the one
failure that looks like success: signups keep working and writes start failing.

### 3. Start it (two terminals)

```bash
npm run start:server                   # http://localhost:5000  (API)
npm run dev:client                     # http://localhost:5173  (site, second terminal)
```

Open `http://localhost:5173`, press **Access Dashboard**, and connect MetaMask on
Sepolia — or use **View demo** below the connect button to explore every console with
no wallet at all.

Check the database connection at any time:

```bash
npm run ping     # reports host, database, collections and doc counts —
                 # and names the fix for the three Atlas errors that actually happen
```

### 4. (Optional) Connect MongoDB Atlas

MongoDB is a **cache, never the source of truth** — four collections (`Records`,
`Identities`, `ChainEvents`, `Profiles`), rebuilt from chain logs at any time with
`npm run index`. The one deliberate off-chain store is `Profiles` (patient-chosen
display names), which never touches the chain.

1. Create a free **M0** cluster (AWS, region closest to you).
2. **Security → Database Access** → add a user with **Read and write to any database**.
3. **Security → Network Access** → allow your IP.
4. **Connect → Drivers → Node.js** and copy the string. Then one edit:

```env
DATABASE_URL=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/apnarecord?retryWrites=true&w=majority
```

> **The database name goes in the path.** Omit `/apnarecord` and Mongo quietly uses a
> database called `test`, and your data appears to vanish. This is the single most common
> Atlas mistake. Also: if the password contains `@ : / ? # [ ] %`, it has to be
> percent-encoded — using letters and digits only avoids the whole problem.

5. `npm run ping` to confirm, then `npm run index` to populate the cache.

---

## How file storage works, end to end

Encryption is **browser-side only**. Nothing trusts the server with plaintext:

1. **Encrypt (browser).** `client/src/crypto.js` generates a random AES-256-GCM content
   key, encrypts the file to `iv | ciphertext | tag`, and computes `keccak256(ciphertext)`
   — the digest. Only that 32-byte digest ever goes on-chain.
2. **Upload (server).** `POST /api/records` carries `{ tokenId, patient, recordType,
   contentKey (32-byte hex), ciphertext (base64) }`. The server recomputes
   `keccak256(ciphertext)` and refuses the write on mismatch, then stores two files beside
   each other in `server/uploads/` (override with `UPLOAD_DIR`): `<digest>.enc`
   (ciphertext) and `<digest>.key` (the content key sealed under `MASTER_KEY` as
   `iv(12) | tag(16) | ciphertext`, base64). Uploads are capped at 20 MB per record.
3. **Mint (contract).** The admin's `mintRecord(patient, digest, cid, recordType)` anchors
   only the digest. The plaintext was never on the wire.
4. **Read (gated).** `GET /api/records/:tokenId/file?viewer=X` runs `eth_call
   viewRecord(tokenId) { from: viewer }` **before touching disk**
   (`server/src/middleware/consentGate.js` — the contract answers, the server never
   guesses). Only on a returned CID does it unseal the key and return
   `{ ciphertext, contentKey }` for local WebCrypto decryption. If the chain knows the
   record but this machine holds no bytes, the API answers `409 BlobMissing` — by design.
5. **Verify (free).** `POST /api/verify` re-runs `verifyRecord` and compares digests; it
   never returns a file.

> Most free hosts wipe the local filesystem on every deploy, so `uploads/*.enc|*.key`
> disappear on redeploy. Mount a persistent disk (`UPLOAD_DIR=/opt/apnarecord/uploads`)
> or accept re-uploads after each deploy.

---

## Environment reference

`server/.env` — copy from `server/.env.example`:

```env
PORT=5000
DATABASE_URL=                           # chains reads work without it; accounts need it

RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
CONTRACT_ADDRESS=
CONTRACT_DEPLOY_BLOCK=

DRIPPER_PRIVATE_KEY=                    # npm run dripper:new — fund the address it prints
DRIP_AMOUNT=0.01                        # per new account. ~100 writes at 2 gwei
DRIP_FLOOR=0.003                        # top up only when an account falls below this
DRIP_DAILY_CAP=1.0                      # circuit breaker, per calendar day
DRIP_LOW_WATER=0.05                     # warn loudly below this

MASTER_KEY=                             # 64 hex chars. Seals record keys AND keys the contact hash

# Identity: the verified email address. `mock` prints the code to the server log
# and returns it to the browser, so the whole flow works with no relay account,
# no verified domain and no DNS records. Production sets resend or brevo.
EMAIL_PROVIDER=mock
EMAIL_FROM="ApnaRecord <no-reply@yourdomain.com>"
# RESEND_API_KEY=                      # resend free tier: 3,000 messages/month
# BREVO_API_KEY=                       # brevo free tier: 300 messages/day
CONTACT_MAX_PER_IP=12                  # codes per caller IP per hour
CONTACT_MAX_PER_HOUR=5                 # codes per address per hour
CONTACT_RESEND_COOLDOWN_MS=30000       # minimum gap between requests for one address

# UPLOAD_DIR=                           # defaults to server/uploads
```

> **On email delivery.** Transactional email needs a relay authenticated for the sending
> domain — **SPF**, **DKIM** and **DMARC** records published, the domain verified at the
> relay, and `EMAIL_FROM` set to an address on it — before any of it reaches an inbox.
> Miss any of those and codes land in spam or nowhere, which looks exactly like a broken
> server. Email OTP has real free tiers (Resend and Brevo among them) and no registration
> gate. The `mock` sender is what this repo defaults to, and it is genuinely usable for
> a demo rather than a stub you have to replace before anything works.

> `server/.env` is loaded by absolute path from `server/src/config/env.js`, which every entry
> point imports **first**. That ordering is load-bearing: ES module imports are evaluated
> before the importing module's body, so a `dotenv.config()` sitting in `index.js` ran *after*
> modules that read `process.env` at their top level had already been evaluated — which meant
> `DRIP_AMOUNT` and `UPLOAD_DIR` were silently ignored in favour of their defaults.

`client/.env` — only needed if you point the site at a different API or contract:

```env
VITE_API_URL=http://localhost:5000/api
VITE_CONTRACT_ADDRESS=<the address you deployed to Base Sepolia>
VITE_CHAIN_ID=84532
VITE_CHAIN_NAME=Base Sepolia
VITE_EXPLORER=https://sepolia.basescan.org/address/
VITE_TX_EXPLORER=https://sepolia.basescan.org/tx/
```

> `VITE_CHAIN_ID` must equal the server's `CHAIN_ID`. It is bound into the EIP-712 read
> domain, so a mismatch rejects every signed read and presents as "permissions are
> broken" rather than as a configuration error.
>
> Leave `VITE_RPC_URL` unset. Reads and writes go through our own backend (`/api/rpc`)
> by default, so the upstream node never sees the user's IP. Setting it points the
> browser straight at a public node and puts that leak back.

> Vite bakes `VITE_*` values in at **build** time, so changing them means rebuilding
> (locally: restart `npm run dev:client`).

---

## Demo accounts

The wallets already registered on the deployed contract. **The app reads roles from the
chain**, so whichever of these you switch to in MetaMask is recognised automatically —
none of this is hardcoded into the role logic.

| Role | Label | Address |
|---|---|---|
| Admin | Platform | `0x436625c20e1f90133c52b6c1728709B295fd82B6` |
| Hospital IT | Hospital 101 | `0xc089766ad7B4E2835f1955D7f7122242CdDA978C` |
| Doctor (Manager) | Doctor 101 | `0xF571447d95883AE1b9596bfd8a32D2713a80EA63` |
| Auditor | Auditor 101 | `0x62A4A7C6dA55aBB06012222F97318B53E784636e` |
| Patient | Patient 101 | `0x194eFBB518Eb356Edb18B7088a7F13629b241348` |

There is **no login page and no test password** — the wallet is the identity. Connect
MetaMask to Base Sepolia and the correct console is offered to you. `/verify` works with no
wallet at all, and **View demo** on `/access` opens every console wallet-free.

---

## Pages

The site has two halves. The **public half** needs no wallet: a landing page, a wallet
gate, and a public verifier. The **product half** opens only after a wallet connects,
and shows only the console that wallet's role entitles it to.

| Route | Who | What it does |
|---|---|---|
| `/` | anyone | Landing page — the hero, the enforced gates, the lifecycle |
| `/access` | anyone | The gate. Connects MetaMask, reads the wallet's role from the contract, and routes it to the one console it holds. **View demo** opens every console wallet-free |
| `/verify` | public | Re-hash a file and compare with the chain. **No wallet, no account** |
| `/admin` | Hospital IT | Dashboard: identities by role, records by type, consent health, identity table |
| `/admin/console` | Hospital IT | Operations: register identity · grant roles · encrypt, store and mint · revoke · try a blocked transfer |
| `/doctor` | Doctor / lab | Dashboard: patient table with names and access state, readable records, per-patient access chart |
| `/doctor/console` | Doctor / lab | Operations: request a record · read with consent · emergency break-glass |
| `/auditor` | Compliance | Dashboard: metadata-only audit view, event log, audit coverage. **Never the file location** |
| `/auditor/console` | Compliance | Ledger and feed views of the complete event log |
| `/patient` | Record owner | Dashboard: your records, who can read them now, activity on your records |
| `/patient/console` | Record owner | Operations: grant a time-boxed window · revoke · open a record · approve/revoke hospital links |
| `/patient/profile` | Record owner | Your display name and details. Off-chain, signed, deletable |
| `/hospital` | Hospital IT | Dashboard: linked patients, in-scope records, expiring windows — nothing else |
| `/hospital/console` | Hospital IT | Operations: request a patient link · discharge · mint for linked patients |

### Display names, and where they come from

The contract records that a wallet is `Patient 101` and owns its tokens. It never learns a
name — that is deliberate, and it is why the design can claim no personal data on-chain.

So names live in a separate **patient-owned profile**: off-chain, writable only by the
wallet it belongs to, and proved by a **signature** rather than a session (the server
rejects signatures older than five minutes, so a captured one cannot be replayed). That
has three consequences worth understanding:

- A forged profile is worthless. Rewrite every name in the database and ownership, consent
  and verification are all unchanged.
- The patient can erase it. That is the DPDP erasure story for the one thing we hold —
  crypto-shredding covers the record, this covers the name.
- Wherever a name appears, the UI labels it **off-chain**, so the provenance is never
  glossed over.

### Demo mode (no wallet needed)

Below the connect button on `/access`, **View demo** opens a persona picker with the four
roles. Picking one loads that account's *real* chain state — roles, ownership, consent
windows — through the backend's public RPC, with no signer attached:

- Dashboards, tables, charts and the verifier all work, because they are reads.
- Anything that writes (minting, granting, revoking, signing a profile) refuses, because
  there is no wallet to sign with. The marigold banner inside the shell says so.
- Each persona is still gated to its own console — demoing the patient never shows the
  admin sidebar.

The choice survives reloads within the tab (session storage) but never leaves it: a fresh
tab starts clean, and nothing about demo mode weakens the real gate.

---

## Honest limits

These are stated plainly because a sharp reader will ask, and a shrug is worse than an
answer.

- **Records are soulbound**, so no ownership-transfer events exist. That is deliberate.
- **The blob fetch is public, deliberately.** `GET /api/wallet/:address` hands over the
  sealed key without proving anything, and it was gated behind the email grant for an
  afternoon before that was reverted. The trade is bad: the ciphertext is AES-GCM over a
  key derived from a 100-bit code at 600k PBKDF2 iterations, so harvesting it is already
  infeasible by about 2^100 — whereas gating it means a patient who changes their email
  address cannot find their wallet at all, and with soulbound records that is permanent. The fetch
  is rate-limited instead, and the recommended path is by email.
- **An email address is the only locator.** Lose the address *and* the recovery code and the
  wallet is gone. Recovery needs a second address, a second code, or a guardian quorum, none
  of which is built. The schema and the grants are shaped to accept them.
- **OTP rate limits are per-process and in-memory.** A restart clears them, and two server
  instances do not share them. A real deployment needs a shared store and a WAF in front,
  because mail bombing is a billing attack rather than a security one.
- **Losing the recovery code loses the records.** The wallet is a plain EOA, not a smart
  account, so there is no signer to rotate — and because the record is soulbound it cannot
  be moved to a new address either. One secret, no recovery. The designed fix (a rotatable
  signer with guardians and a veto window) needs a new contract deployed, which is why the
  enrolment screen states the risk in red rather than implying a reset exists.
- **The unlocked key lives in `sessionStorage` for the life of the tab.** That is the price
  of having no extension to isolate it: anything running script on the origin can read it
  while a session is open. A passkey-signed smart account removes the stored key entirely,
  and `getSigner()` is the single seam that would change.
- **The dripper's key sits on the server.** It cannot sign as anyone — only send test ETH —
  but on a network where the balance had value it would be a honeypot. It is testnet-only
  by construction.
- **The read proof's replay guard is in-memory**, so it is per-process and cleared by a
  restart. The five-minute validity window is the real bound. A durable store is the answer
  the day this runs on more than one instance.
- **Emergency break-glass bypasses consent by design** — one hour, one record, and the
  reason is permanently on-chain.
- **In this demo the key wrapping is handled by the backend.** Each record has its own
  AES-256-GCM key, sealed under a server master key; the server never stores a raw key.
  Delegating the release of wrapped keys to a decentralised key-management network is the
  **production path, not something built here**.
- **The CID is unexposed, not hidden.** Solidity `private` only removes it from the ABI.
  Encryption is what protects the file, and the contract gates the location.
- **Identity is a verified email address, and nothing else.** There is no national-ID
  integration, no adapter waiting to be plugged in, and no reserved field for one. A contact
  locates an account and can never open one, which is what keeps this from drifting into being
  an identity system by accident.
- **The demo walkthrough cannot read records.** A persona holds no key, so it cannot sign a
  read proof. Dashboards, charts and metadata all still work — only the file reader stops,
  and it explains why rather than failing silently.
- `local://` appears as the record location. Real deployments use IPFS; the storage layer
  is written so that is a swap rather than a rewrite.
- This is a **testnet demo with synthetic data**. No real patient data is involved.

---

## Repository layout

```
contracts/ApnaRecord.sol        the deployed contract, as source (Solidity 0.8.24, ERC-721 + AccessControl, ERC-5192 soulbound)
client/                         React 18 + Vite 6 + Tailwind 3 + ethers v6
  src/App.jsx                   routes: / · /access · /verify · /admin · /doctor · /auditor · /patient (+ consoles)
  src/chain.jsx                 ALL ethers lives here — pages never touch it
  src/contract.js               contract address, chain id, API URL (VITE_* env)
  src/crypto.js                 browser-side AES-256-GCM + keccak256
  src/services/api.js           the only place that calls the backend
  src/components/ui.jsx         cards, callouts, the six status tokens, skeletons
  src/components/Brand.jsx      the wordmark and mark, in one place
  src/components/shell/         AppShell (collapsible sidebar), RoleGate, PublicChrome, DemoBanner
  src/components/viz/           charts, lifecycle diagram, StatCard/DataTable primitives
  src/config/demoAccounts.js    demo personas (convenience only — roles always come from the contract)
  src/hooks/useReveal.jsx       the landing page's only scroll animation
  src/hooks/useTableState.js    search + filter + sort + paginate, in one place
  src/hooks/useEventFeed.js     the server-filtered, server-paged event log
  src/components/DashboardBar.jsx  last-read time, cache provenance, refresh, export
  src/components/Drawer.jsx     the drill-down panel (chosen over a modal, on purpose)
  src/components/RecordTimeline.jsx  one record's history, fetched independently
  src/components/ExpiryWatchlist.jsx windows closing within 24 hours
  src/components/PanelBoundary.jsx   per-panel error boundary with a retry
  src/lib/format.js             relative + absolute time, addresses, record types
  src/lib/csv.js                client-side CSV export (with a BOM, for Excel)
  src/pages/                    Home, Access gate, Verify, Profile + one console per role
  src/pages/dashboards/         read-only dashboard per role
  src/styles/style.css          design tokens as component/utility layers
  tailwind.config.js            the palette, including the remapped legacy ramps
  vercel.json                   SPA rewrites so /access · /admin · /verify survive refresh
server/                         Express 4 + Mongoose 8
  src/index.js                  entry — `node src/index.js`, CORS open, 30 MB JSON ceiling for ciphertext
  src/routes/apiRoutes.js       /api/health · /api/chain/* · /api/records* · /api/audit/:id · /api/verify · /api/stats · /api/profiles* · /api/identity/email/* · /api/wallet/* · /api/dripper · /api/identities · /api/facilities · /api/requests · /api/patients/:address/links
  src/middleware/consentGate.js THE GATE — one eth_call, never guesses
  src/controllers/directoryController.js  signed directory writes: identities, facilities, requests + facility/patient reads
  src/lib/facilityScope.js      the hospital read scope: currently linked patients, from the database
  src/lib/email.js              normalise + keyed HMAC + masked display; the address is never stored
  src/lib/codes.js              six-digit codes, grant tokens, hashes
  src/services/emailSender.js   mock (default) · resend · brevo; a refused send throws
  src/services/otp.js           contact-agnostic codes: cooldown, hourly cap, five guesses, single-use grants
  src/controllers/              health, chain, stats, records, profiles, identity, wallet
  src/services/chain.js         read-only chain access; no signer exists here
  src/services/storage.js       ciphertext blobs + content-key sealing (AES-256-GCM, UPLOAD_DIR-aware)
  src/models/index.js           Records · Identities · ChainEvents · Profiles (all rebuildable)
  src/scripts/indexer.js        `npm run index` — rebuild the Mongo cache from chain logs
  src/scripts/ping.js           `npm run ping` — connection, host, collections, doc counts
render.yaml                     Render blueprint: apnarecord-api (Root server, health check /api/health)
package.json                    root scripts: dev:client · dev:server · start:server · build:client · index · ping
```

---

## Contract, briefly

| Group | Functions |
|---|---|
| Identity | `createIdentity` · `deactivateIdentity` · `didFor` |
| Records | `requestRecord` (Manager) · `mintRecord` (Admin) · `revokeRecord` (Admin) |
| Consent | `grantAccess` · `revokeAccess` (owner) · `emergencyAccess` (Manager, 1 hour, logged) |
| Reads | `canAccess` · `viewRecord` · `verifyRecord` · `auditRecord` · `locked` |

**Compiling it yourself? Set the EVM version to Cancun.** Solidity 0.8.24 defaults to the
older `shanghai` target, while current OpenZeppelin releases use the `mcopy` instruction,
which exists only from Cancun onwards. Without that setting you get a `DeclarationError`
naming `mcopy` inside `Bytes.sol`. The contract is fine; the compiler setting is what is
wrong.

---

## Verifying the claims yourself

```bash
# Is the database reachable, and which store is answering?
npm run ping
curl localhost:5000/api/records     # "source": "database" | "chain"

# The chain is genuinely reachable from the backend
curl localhost:5000/api/chain/status

# Every identity and role, rebuilt from logs
curl localhost:5000/api/chain/identities

# The event log, filtered and paged server-side
curl "localhost:5000/api/chain/events?name=AccessGranted&limit=5&offset=0"
# -> {"events":[…],"total":5,"offset":0,"limit":5,"scanned":1000,…}

# One record's whole life, oldest first, with the actor named on every line
curl localhost:5000/api/chain/records/1/history

# The dashboards' aggregates, bypassing the 60-second server cache
curl "localhost:5000/api/stats?fresh=1"
# -> includes totals.expiringSoon, per-consent context, and a timestamp per event

# A viewer with no consent is refused BY THE CONTRACT.
#
# But naming a viewer is no longer enough — the read must be signed by the wallet
# it claims to be. An unsigned request is rejected before the contract is consulted:
curl "localhost:5000/api/records/1/file?viewer=0xF2538724d814ef3900095f6e0fa0DFac8F9ad31d"
# -> 401 {"error":"ProofRequired","message":"This record is released only to a caller who
#          proves they hold the viewer key. Missing header(s): x-apnarecord-issued-at, …"}

# With a signature it gets through to the contract, which then decides:
#   x-apnarecord-viewer       the address being claimed
#   x-apnarecord-issued-at    milliseconds; a proof is valid for five minutes
#   x-apnarecord-nonce        32 random bytes, single use
#   x-apnarecord-signature    EIP-712 over {tokenId, viewer, issuedAt, nonce}
# -> 403 {"error":"AccessDenied"}  or  {"error":"Expired"}  or the record itself

# Verification is free and needs no permission
curl -X POST localhost:5000/api/verify -H 'Content-Type: application/json' \
  -d '{"tokenId":1,"fileHash":"0x72e377aea98522cd2c9f9f4a5941d1bdb2defa5033cc1e2cf1edd7e8b37a5094"}'
# -> {"authentic": true, "verifiedBy": "contract.verifyRecord"}

# The gas float: how much is left, and how many accounts it still covers
curl localhost:5000/api/dripper
# -> {"enabled":true,"balanceEth":"9.95","enrolmentsRemaining":995,"low":false,…}

# What the server holds for a wallet — ciphertext, and nothing else
curl localhost:5000/api/wallet/0xYourAddress
# -> {"enrolment":{"sealed":"…","salt":"…","iterations":600000}, …}
#    There is no endpoint anywhere in this API that can sign, decrypt, or act as a user.
```

To convince yourself the storage claim is real rather than asserted, this is the whole of it
— run it against a database with accounts in it:

```bash
docker exec -i <mongo> mongosh apnarecord --quiet --eval '
let hits = 0;
db.enrolments.find({}).forEach(d => {
  const copy = JSON.parse(JSON.stringify(d));
  delete copy.sealed; delete copy.salt; delete copy._id;
  if (copy.drip) delete copy.drip.txHash;
  if (/[0-9a-f]{64}/i.test(JSON.stringify(copy))) { hits++; print("LEAK " + d.address); }
});
print(hits === 0 ? "no raw key, no recovery code, no derived material" : hits + " leak(s)");
'
```

---

## Testing

```bash
npm test               # everything. Starts a stub chain and a server, then tears them down
npm run test:unit      # email, codes and relay adapters only — no server, no database
```

`npm test` needs **MongoDB reachable** and nothing else — the chain and the mail relay are
both stubbed, so no testnet funds and no relay account are involved.

```bash
docker run -d -p 27017:27017 mongo:7
npm test
```

It uses `mongodb://127.0.0.1:27017/apnarecord_test`, a database of its own, so a run cannot
clear the data you develop against. Point it elsewhere with `DATABASE_URL`.

The three suites cover, in order: the email library and each relay adapter against a stub
endpoint; verification over HTTP including the cooldown, the caps, the five-guess lockout
and grant reuse; and enrolment end to end, where both proofs are required, a spent grant is
refused, the sealed blob opens only with the recovery code, and concurrent enrolments
produce no nonce collision.

`tests/README.md` explains what each suite needs and calls out the three assertions that are
easy to weaken into passing for the wrong reason.

---

## Deploying (Vercel + Render)

Two services, deployed separately: the **API** on Render, the **site** on Vercel.

### 1. API on Render

Use **New → Web Service** — not Blueprint (`render.yaml` exists, but Blueprint mode asks
for a credit card).

| Setting | Value |
|---|---|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `node src/index.js` |
| Health Check Path | `/api/health` |

Environment variables: `DATABASE_URL` and `MASTER_KEY` (paste your secrets), plus
`RPC_URL`, `CONTRACT_ADDRESS`, `CONTRACT_DEPLOY_BLOCK` from `server/.env.example`.

Two caveats on free tiers: the service **sleeps after ~15 min idle** (warm it by hitting
`/api/health` before a demo), and the disk is **ephemeral** (uploads vanish on redeploy —
see the storage section). If Atlas is used, allow `0.0.0.0/0` in **Network Access** so
Render can reach it.

### 2. Site on Vercel

| Setting | Value |
|---|---|
| Root Directory | `client` |
| Framework | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |

```env
VITE_API_URL=https://<your-render-service>.onrender.com/api
VITE_CONTRACT_ADDRESS=
VITE_CHAIN_ID=84532
```

> Vite bakes `VITE_*` in at build time, so **updating an env var requires a redeploy**:
> Settings → Environment Variables → edit → Save → Deployments → ⋯ → Redeploy.
> `client/vercel.json` already handles SPA rewrites, so `/access`, `/admin` and `/verify`
> survive refresh.

---

## License

MIT
