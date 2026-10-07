import mongoose from 'mongoose';

export const isDbReady = () => mongoose.connection.readyState === 1;

const RecordSchema = new mongoose.Schema(
  {
    tokenId: { type: Number, required: true, unique: true, index: true },
    // Empty for a revoked record: `revokeRecord` burns the token, so the chain has no
    // owner left to name. It cannot be `required` any more — the indexer mirrors the
    // burned state instead of crashing on it.
    patient: { type: String, default: '', index: true, lowercase: true },
    recordType: { type: String, required: true },
    // Set when the token has been revoked and burned. The dashboards render it, so it has
    // to be a real field: the records list used to hardcode `burned: false`, which meant a
    // revoked record was presented as live on the browse index while the chain said
    // otherwise.
    burned: { type: Boolean, default: false },
    // keccak256 of the ciphertext. Also the on-disk blob name and the on-chain anchor.
    recordHash: { type: String, required: true, unique: true, index: true, lowercase: true },
    // keccak256 of the PLAINTEXT, and the reason it is stored separately.
    //
    // The anchor above is a hash of the ciphertext, which is the right thing for
    // object integrity -- it names the blob. But it makes the public verify page
    // useless to the person who registered the record: they hold the scan, not the
    // ciphertext, and encryption uses a fresh IV every time, so they can never
    // reproduce it. Uploading their own file answered "Tampered".
    //
    // So the plaintext digest is recorded too. It is a hash, not the file, and it is
    // checked against the server's record rather than the chain -- a weaker claim, and
    // the response says which of the two matched so it is never mistaken for the other.
    plainHash: { type: String, default: '', lowercase: true, index: true },
    cid: { type: String, default: '' },
    // Content key, sealed under the server master key. Never the raw key.
    sealedKey: { type: String, required: true },
    fileName: { type: String, default: 'record.bin' },
    mimeType: { type: String, default: 'application/octet-stream' },
    sizeBytes: { type: Number, default: 0 },
    mintedAtBlock: { type: Number, default: 0 },
    mintedTx: { type: String, default: '' },
    // The facility that minted it, or '' when the platform admin did. Mirrors the chain,
    // which stamps the same value from the minter — and it is the field the hospital's
    // read scope is derived from, since the chain cannot enforce reads.
    facility: { type: String, default: '', lowercase: true, index: true },
  },
  { timestamps: true }
);

const IdentitySchema = new mongoose.Schema(
  {
    account: { type: String, required: true, unique: true, lowercase: true, index: true },
    label: { type: String, default: '' },
    // Which hospital this account belongs to, as STAFF. Empty for patients and for
    // platform-level identities — a patient visits hospitals, they do not work at one,
    // and conflating the two would put patients in the staff roster.
    facility: { type: String, default: '', lowercase: true, index: true },
    active: { type: Boolean, default: true },
    registeredAtBlock: { type: Number, default: 0 },
    roles: {
      admin: { type: Boolean, default: false },
      manager: { type: Boolean, default: false },
      auditor: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

const ChainEventSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, index: true },
    blockNumber: { type: Number, required: true },
    txHash: { type: String, required: true },
    logIndex: { type: Number, default: 0 },
    args: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
ChainEventSchema.index({ txHash: 1, name: 1, logIndex: 1 }, { unique: true });

/**
 * Off-chain, patient-owned display profile.
 *
 * Deliberately NOT part of the trust story, and the UI says so. The chain records
 * that a wallet is "Patient 101" and owns its tokens; it never learns a name.
 * This collection exists so a dashboard can show a person's name instead of an
 * address, and it is:
 *   - editable only by the wallet it belongs to, proved by signature, not a session
 *   - deletable by that wallet
 *   - worthless to an attacker: forge every name in here and ownership, access
 *     control and verification are all unchanged
 *
 * The rule the design commits to still holds: nothing authoritative is PII.
 */
const ProfileSchema = new mongoose.Schema(
  {
    account: { type: String, required: true, unique: true, lowercase: true, index: true },
    displayName: { type: String, default: '', trim: true, maxlength: 80 },
    dateOfBirth: { type: String, default: '' },
    bloodGroup: { type: String, default: '' },
    allergies: { type: String, default: '', maxlength: 300 },
    emergencyContact: { type: String, default: '', maxlength: 120 },
    // Provenance for the UI badge: this was written by the wallet holder.
    verifiedBySignature: { type: Boolean, default: false },
    lastSignedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * A wallet the product created for a user, and the identity it is bound to.
 *
 * THE INVARIANT THIS COLLECTION EXISTS TO PRESERVE. `sealed` is ciphertext, and the
 * key that opens it is derived from a recovery code the user wrote down. The server
 * never sees that code and cannot open the blob, so an attacker who exfiltrates this
 * entire collection gains no ability to sign anything as anyone.
 *
 * There is deliberately no field here for a private key, a recovery code, or a
 * derived key. Adding one would quietly convert the product into a custodian — the
 * hospital could then consent on a patient's behalf, and the central claim of the
 * system would become false rather than merely imperfect.
 *
 * Note that enrol/keystore endpoints REQUIRE the database, unlike the rest of the
 * API. That is a real change: chain reads still work with Mongo down, but nobody
 * can create or unlock a wallet.
 */
const EnrolmentSchema = new mongoose.Schema(
  {
    // The account — what owns the records, for ever. This is the identity everything
    // else refers to, and the address the client looks itself up by.
    address: { type: String, required: true, unique: true, lowercase: true, index: true },
    // The key that signs for that account. Registered as the account's owner on-chain,
    // and the only thing the account will accept an `execute` from.
    //
    // Stored so a repeat enrolment with the same key returns the SAME account instead
    // of deploying a second one — without it, a user who refreshed mid-flow, or simply
    // enrolled twice, would end up with two accounts and no way to tell which held
    // their records.
    owner: { type: String, required: true, unique: true, lowercase: true, index: true },
    sealed: { type: String, required: true },
    salt: { type: String, required: true },
    iterations: { type: Number, default: 600000 },
    // Set when the owner replaces their recovery code. Null means never rotated, which
    // is the common case — rotation exists for the day a code leaked, not as routine
    // hygiene, and a field that is usually null still earns its place by making the
    // exceptional case visible.
    rotatedAt: { type: Date, default: null },

    // What the person chose at signup. A REQUEST, not a grant -- the chain grants
    // nothing until an administrator acts. Top level, NOT inside `identity`: it is an
    // attribute of the enrolment, and nesting it is why the write was silently dropped.
    requestedRole: { type: String, default: '' },
    // The verified contact binding.
    //
    // `kind` has exactly one legal value and is not a seam for anything — there is no
    // national-ID or other provider waiting to occupy it. It is kept because a
    // self-describing field costs nothing and reads better than an unnamed one.
    //
    // Note what is stored: a keyed hash used for lookup, and a masked form for display.
    // The address itself is never persisted — it exists inside the send call and then
    // nowhere, which is what keeps holding contacts from becoming the liability it
    // usually is.
    identity: {
      kind: { type: String, default: 'email', enum: ['email'] },
      emailHmac: { type: String, default: '' },
      emailMasked: { type: String, default: '' },

      // What the person said they were registering as. A REQUEST, not a grant: at this
      // point they are only email-verified, and nothing on the contract has been touched.      verifiedAt: { type: Date, default: null },
    },
    drip: {
      amount: { type: String, default: '' },
      txHash: { type: String, default: '' },
      at: { type: Date, default: null },
      topUps: { type: Number, default: 0 },
    },
    // The deployment of the account this row is about. Kept so the creation is
    // auditable from our side too, rather than only from a block explorer.
    account: {
      txHash: { type: String, default: '' },
      deployedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

/**
 * ONE EMAIL, ONE WALLET.
 *
 * `address` was already unique, so a wallet could not be duplicated. Nothing stopped
 * the reverse: the same email bound to unlimited wallets, each taking a 0.01 ETH drip
 * at enrolment. The only ceiling was the global daily cap, which is a budget rather
 * than a control — it decides how fast the float drains, not whether it is farmable.
 *
 * PARTIAL, because rows that predate this have `emailHmac: ''` and would all collide
 * on the empty string. `partialFilterExpression` cannot express "not empty" (`$ne` is
 * unsupported), but every real value is a 64-character hex digest, so `$gt: ''` admits
 * exactly the rows that have one and ignores the rest. A missing field does not match
 * `$gt` either, which is the behaviour we want.
 */
EnrolmentSchema.index(
  { 'identity.emailHmac': 1 },
  { unique: true, partialFilterExpression: { 'identity.emailHmac': { $gt: '' } } }
);

/**
 * A one-time code, on its way to a contact.
 *
 * Note what is NOT here: the contact, and the code. The contact is stored only as a keyed
 * hash, and the code only as a hash of (contact hash + code), so neither a database dump
 * nor a log gives anyone a working code. `purpose` exists so a code minted to verify an
 * enrolment cannot be replayed against a wallet lookup.
 */
const OtpSchema = new mongoose.Schema(
  {
    contactHmac: { type: String, required: true, index: true },
    purpose: { type: String, required: true, default: 'enrol' },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
// Mongo removes the row itself when the code dies, so nothing has to sweep.
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Proof that a contact was verified just now, and by whom.
 *
 * This is the *only* thing that lets a caller look up a sealed blob by contact. It is a
 * bearer token, so only its hash is stored, it is single-use, and it is short-lived.
 *
 * It deliberately cannot open a wallet. Locating a wallet and opening one are different
 * operations, and keeping them separate is what stops an inbox takeover from becoming an
 * account takeover.
 */
const ContactGrantSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    contactHmac: { type: String, required: true, index: true },
    // Carried on the grant so the enrolment records the masked form the SERVER derived,
    // rather than whatever text a client chose to send alongside a verified contact.
    contactMasked: { type: String, default: '' },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
ContactGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Legacy per-hit rate-limit rows, retained so existing rows can expire through their
 * TTL index. New hits are recorded by the atomic rolling-window model below.
 */
const RateLimitSchema = new mongoose.Schema(
  {
    bucket: { type: String, required: true },
    key: { type: String, required: true },
    at: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
RateLimitSchema.index({ bucket: 1, key: 1, at: 1 });
RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Atomic rolling-window abuse limits. Each unique (bucket, key) row stores at most
 * `limit` accepted hit timestamps; conditional pruning and appending happen in one
 * update, shared by every API instance.
 */
const RateLimitBucketSchema = new mongoose.Schema(
  {
    bucket: { type: String, required: true },
    key: { type: String, required: true },
    hits: { type: [Date], default: [] },
    allowed: { type: Boolean, default: false },
    updatedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);
RateLimitBucketSchema.index({ bucket: 1, key: 1 }, { unique: true });
RateLimitBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * A value that may be used exactly once — read-proof nonces, and anything else where
 * a repeat is an attack rather than an inconvenience.
 *
 * A UNIQUE index does the work, not a lookup followed by a write. "Check then insert"
 * has a window between the check and the write, and a replay is precisely the kind of
 * request that arrives in that window. Letting the database refuse the duplicate is
 * atomic and needs no locking.
 */
const OneShotSchema = new mongoose.Schema(
  {
    bucket: { type: String, required: true },
    key: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
OneShotSchema.index({ bucket: 1, key: 1 }, { unique: true });
OneShotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * HOW MANY TIMES ONE CONTACT MAY BE FUNDED.
 *
 * Enrolment funds a wallet immediately, and there is also a top-up path for a clinician
 * who burns through their allowance. Both draw on the same float, and both were gated
 * only by a floor check — "does this address have enough?" — which is a question about
 * a wallet, not about a person.
 *
 * That is farmable. Create a wallet, take a drip, rebind to a fresh address (which has
 * a zero balance and so passes the floor check), take another. The floor check cannot
 * see that the same person is asking.
 *
 * So the count lives against the CONTACT, which is the only handle we have on a person.
 * A COUNT rather than a wei total, because wei does not fit in a JavaScript number and
 * an atomic comparison of decimal strings in MongoDB is not something to attempt.
 *
 * The `$lt` in the filter plus `upsert` plus the unique index is what makes this
 * correct: a caller at the cap cannot match the filter, the upsert then collides with
 * the unique index, and the duplicate-key error IS the refusal. A read-then-write would
 * let two simultaneous drips both pass.
 */
const DripLedgerSchema = new mongoose.Schema(
  {
    contactHmac: { type: String, required: true, unique: true },
    address: { type: String, default: '' },
    dripCount: { type: Number, default: 0 },
    txHash: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const DripperTransactionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    nonce: { type: Number, required: true },
    kind: { type: String, enum: ['transfer', 'deployment'], required: true },
    to: { type: String, default: '' },
    value: { type: String, default: '0' },
    data: { type: String, default: '0x' },
    fingerprint: { type: String, required: true },
    rawTransaction: { type: String, default: '' },
    txHash: { type: String, default: '' },
    state: { type: String, enum: ['reserved', 'signed', 'broadcast'], default: 'reserved' },
    lastError: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const DripperDeploymentSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true },
    txHash: { type: String, required: true },
    address: { type: String, required: true },
    chainId: { type: String, required: true },
    completedAt: { type: Date, required: true },
  },
  { _id: false }
);

/**
 * The dripper's shared nonce state, keyed by the float's address. The next intent,
 * reserved nonce, and exact signed transaction bytes live together so a process crash
 * cannot leave a nonce claim with no durable information about what may have been sent.
 */
const DripperSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, unique: true },
    nextNonce: { type: Number, required: true, default: 0 },
    nonceStateVersion: { type: Number, default: 0 },
    // Retained only to detect unresolved claims from the earlier counter-only format.
    inFlight: { type: Number, default: 0 },
    inFlightAt: { type: Date, default: null },
    nonceLeaseId: { type: String, default: '' },
    nonceLeaseUntil: { type: Date, default: null },
    activeTransaction: { type: DripperTransactionSchema, default: null },
    recentDeployments: { type: [DripperDeploymentSchema], default: [] },

    // What this float has sent today, as a COUNT rather than a wei total.
    // Every drip is exactly one AMOUNT, and wei does not fit in a JavaScript
    // number — so a running total would be a decimal string Mongo cannot increment
    // atomically, while a count can be incremented and multiplied by AMOUNT at read
    // time. `spentDay` is the YYYY-MM-DD the count belongs to.
    spentDay: { type: String, default: '' },
    spentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * A hospital, as a first-class thing.
 *
 * Keyed by the hospital-IT wallet, which IS the facility on-chain. The contract has no
 * name field, deliberately: a hospital's name is organisation data and there is no reason
 * to publish it permanently beside an address. The name lives here, joined in by the API —
 * which is also the only layer that can enforce who sees it, since the chain cannot gate
 * reads.
 */
const FacilitySchema = new mongoose.Schema(
  {
    it: { type: String, required: true, unique: true, lowercase: true, index: true },
    name: { type: String, required: true },
    active: { type: Boolean, default: true },
    createdTx: { type: String, default: '' },
  },
  { timestamps: true }
);

/**
 * Which patients a hospital is treating, and whether they agreed.
 *
 * The minting gate reads this: a hospital may not mint for a patient it has not linked.
 * And it may not link one without the patient's approval — otherwise "admitted" becomes a
 * backdoor around consent, and any hospital could read anyone by admitting them.
 */
const PatientLinkSchema = new mongoose.Schema(
  {
    facility: { type: String, required: true, lowercase: true, index: true },
    patient: { type: String, required: true, lowercase: true, index: true },
    state: { type: String, enum: ['requested', 'linked', 'ended'], default: 'requested' },
    requestedAt: { type: Date, default: Date.now },
    consentedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    txHash: { type: String, default: '' },
  },
  { timestamps: true }
);
// One row per pair, updated through request → consent → end, so a patient re-admitted to
// the same hospital does not accumulate a row per visit.
PatientLinkSchema.index({ facility: 1, patient: 1 }, { unique: true });

/**
 * A doctor asking for a record.
 *
 * Off-chain, because a request names the patient and the record type — precisely the two
 * things that came off the chain. The chain keeps only the anchor, `RecordRequested`, so
 * the ledger's contents are now trusted to the server. That is what metadata privacy
 * costs, and it is better said than implied.
 */
const RequestSchema = new mongoose.Schema(
  {
    requestId: { type: Number, required: true, unique: true, index: true },
    requester: { type: String, required: true, lowercase: true, index: true },
    patient: { type: String, required: true, lowercase: true, index: true },
    recordType: { type: String, default: '' },
    facility: { type: String, default: '', lowercase: true, index: true },
    issuedAt: { type: Date, default: Date.now },
    fulfilledByTokenId: { type: Number, default: null },
  },
  { timestamps: true }
);

// Every export below is guarded with `mongoose.models.X ||` so `node --watch` reloads do
// not throw OverwriteModelError.
/**
 * A short-lived bearer token, issued in exchange for one signature.
 *
 * The read proof's nonce is single-use — that is the replay guard, and it is correct —
 * which means one proof authorises exactly one request. Gating reads on proofs alone
 * would therefore prompt MetaMask on every page load, and a security measure that
 * people click through without reading is not one.
 *
 * So: sign once, exchange for a token, reuse it until it expires. The TTL index removes
 * expired rows, which makes the window the token's lifetime rather than something the
 * server has to sweep.
 *
 * The token is opaque and random. It carries no claims, because there is nothing to
 * claim: the viewer is a row here, and entitlement is still decided against the chain
 * on every request. Stealing one gets an attacker the same reads they could already
 * perform — but not the ability to act as anyone, because every write is still signed.
 */
const SessionSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    viewer: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RecordModel = mongoose.models.Record || mongoose.model('Record', RecordSchema);
export const SessionModel = mongoose.models.Session || mongoose.model('Session', SessionSchema);
export const FacilityModel = mongoose.models.Facility || mongoose.model('Facility', FacilitySchema);
export const PatientLinkModel =
  mongoose.models.PatientLink || mongoose.model('PatientLink', PatientLinkSchema);
export const RequestModel = mongoose.models.Request || mongoose.model('Request', RequestSchema);
export const IdentityModel = mongoose.models.Identity || mongoose.model('Identity', IdentitySchema);
export const ChainEventModel = mongoose.models.ChainEvent || mongoose.model('ChainEvent', ChainEventSchema);
export const ProfileModel = mongoose.models.Profile || mongoose.model('Profile', ProfileSchema);
export const EnrolmentModel = mongoose.models.Enrolment || mongoose.model('Enrolment', EnrolmentSchema);
export const OtpModel = mongoose.models.Otp || mongoose.model('Otp', OtpSchema);
export const ContactGrantModel =
  mongoose.models.ContactGrant || mongoose.model('ContactGrant', ContactGrantSchema);
export const RateLimitModel = mongoose.models.RateLimit || mongoose.model('RateLimit', RateLimitSchema);
export const RateLimitBucketModel =
  mongoose.models.RateLimitBucket || mongoose.model('RateLimitBucket', RateLimitBucketSchema);
export const OneShotModel = mongoose.models.OneShot || mongoose.model('OneShot', OneShotSchema);
export const DripperModel = mongoose.models.Dripper || mongoose.model('Dripper', DripperSchema);
export const DripLedgerModel =
  mongoose.models.DripLedger || mongoose.model('DripLedger', DripLedgerSchema);

export const allModels = [
  RecordModel,
  IdentityModel,
  FacilityModel,
  PatientLinkModel,
  RequestModel,
  ChainEventModel,
  ProfileModel,
  EnrolmentModel,
  OtpModel,
  ContactGrantModel,
  RateLimitModel,
  RateLimitBucketModel,
  OneShotModel,
  DripperModel,
  DripLedgerModel,
];
