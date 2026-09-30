import mongoose from 'mongoose';

export const isDbReady = () => mongoose.connection.readyState === 1;

const RecordSchema = new mongoose.Schema(
  {
    tokenId: { type: Number, required: true, unique: true, index: true },
    patient: { type: String, required: true, index: true, lowercase: true },
    recordType: { type: String, required: true },
    // keccak256 of the ciphertext. Also the on-disk blob name and the on-chain anchor.
    recordHash: { type: String, required: true, unique: true, index: true, lowercase: true },
    cid: { type: String, default: '' },
    // Content key, sealed under the server master key. Never the raw key.
    sealedKey: { type: String, required: true },
    fileName: { type: String, default: 'record.bin' },
    mimeType: { type: String, default: 'application/octet-stream' },
    sizeBytes: { type: Number, default: 0 },
    mintedAtBlock: { type: Number, default: 0 },
    mintedTx: { type: String, default: '' },
  },
  { timestamps: true }
);

const IdentitySchema = new mongoose.Schema(
  {
    account: { type: String, required: true, unique: true, lowercase: true, index: true },
    label: { type: String, default: '' },
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
    address: { type: String, required: true, unique: true, lowercase: true, index: true },
    sealed: { type: String, required: true },
    salt: { type: String, required: true },
    iterations: { type: Number, default: 600000 },
    // The verified contact binding. `kind` is the seam another identity provider would
    // occupy later; today it is always 'email'.
    //
    // Note what is stored: a keyed hash used for lookup, and a masked form for display.
    // The address itself is never persisted — it exists inside the send call and then
    // nowhere, which is what keeps holding contacts from becoming the liability it
    // usually is.
    identity: {
      kind: { type: String, default: 'email', enum: ['email'] },
      emailHmac: { type: String, default: '', index: true },
      emailMasked: { type: String, default: '' },
      verifiedAt: { type: Date, default: null },
    },
    drip: {
      amount: { type: String, default: '' },
      txHash: { type: String, default: '' },
      at: { type: Date, default: null },
      topUps: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
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

// Guarded so `node --watch` reloads do not throw OverwriteModelError.
export const RecordModel = mongoose.models.Record || mongoose.model('Record', RecordSchema);
export const IdentityModel = mongoose.models.Identity || mongoose.model('Identity', IdentitySchema);
export const ChainEventModel = mongoose.models.ChainEvent || mongoose.model('ChainEvent', ChainEventSchema);
export const ProfileModel = mongoose.models.Profile || mongoose.model('Profile', ProfileSchema);
export const EnrolmentModel = mongoose.models.Enrolment || mongoose.model('Enrolment', EnrolmentSchema);
export const OtpModel = mongoose.models.Otp || mongoose.model('Otp', OtpSchema);
export const ContactGrantModel =
  mongoose.models.ContactGrant || mongoose.model('ContactGrant', ContactGrantSchema);

export const allModels = [
  RecordModel,
  IdentityModel,
  ChainEventModel,
  ProfileModel,
  EnrolmentModel,
  OtpModel,
  ContactGrantModel,
];
