import { Router } from 'express';
import { getHealth } from '../controllers/healthController.js';
import {
  chainStatus,
  chainIdentities,
  chainPermissions,
  chainEvents,
  chainRecordHistory,
  audit,
  verify,
} from '../controllers/chainController.js';
import {
  listRecords,
  getRecord,
  listByOwner,
  storeRecord,
  releaseFile,
} from '../controllers/recordController.js';
import {
  listProfiles,
  getProfile,
  upsertProfile,
  deleteProfile,
} from '../controllers/profileController.js';
import { stats } from '../controllers/statsController.js';
import { enrol, getWallet, lookupWallets, requestDrip, dripperHealth, rebind } from '../controllers/walletController.js';
import { sendCode, checkCode } from '../controllers/identityController.js';
import {
  recordIdentity,
  recordFacility,
  recordRequest,
  facilityDetail,
  patientLinks,
} from '../controllers/directoryController.js';
import { requireConsent } from '../middleware/consentGate.js';

const router = Router();

// Health probe — used by the host's health check.
router.get('/health', getHealth);

// --- Identity: a verified email address ---
//
// An address locates a wallet. It can never open one — that still needs the recovery
// code — which is what keeps an inbox being compromised from being a records breach.
router.post('/identity/email/request', sendCode);
router.post('/identity/email/verify', checkCode);

// --- Directory: the metadata the chain refused to carry ---
//
// Labels, facility names and request contents are off-chain. Every write is
// signed by a wallet the chain authorises for the matching on-chain act.
router.post('/identities', recordIdentity);
router.post('/facilities', recordFacility);
router.post('/requests', recordRequest);
router.get('/facilities/:it', facilityDetail);
router.get('/patients/:address/links', patientLinks);

// --- Wallet creation and funding ---
//
// The key is generated and sealed in the browser; the server is only ever handed
// ciphertext it cannot open. There is no route here that can sign as a user.
router.post('/wallet/enrol', enrol);
// Find your wallets from a verified email address. Replaces looking one up by address.
router.post('/wallet/lookup', lookupWallets);
// Move a wallet to a new key while it still holds nothing. Declared before the
// `:address` routes so the literal path is never read as an address.
router.post('/wallet/rebind', rebind);
router.post('/wallet/:address/drip', requestDrip);
router.get('/wallet/:address', getWallet);

// The gas float's health. Check this before a demo: a dripper that has quietly
// emptied is the one failure that looks like success.
router.get('/dripper', dripperHealth);

// Chain reads. No wallet, no consent, no account.
router.get('/chain/status', chainStatus);
router.get('/chain/identities', chainIdentities);
router.get('/chain/permissions/:address', chainPermissions);
router.get('/chain/events', chainEvents);
// One record's own timeline — what a drill-down opens into.
router.get('/chain/records/:tokenId/history', chainRecordHistory);

// Dashboard aggregates, assembled from chain state.
router.get('/stats', stats);

// Patient-owned display profiles. Off-chain convenience data: the chain records
// that a wallet is "Patient 101", never a name. Writes are authorised by a wallet
// signature rather than a session, because there is no session to have.
router.get('/profiles', listProfiles);
router.get('/profiles/:address', getProfile);
router.put('/profiles/:address', upsertProfile);
router.delete('/profiles/:address', deleteProfile);

// Record index and storage. Note: /owner/:address must precede /:tokenId.
router.get('/records', listRecords);
router.post('/records', storeRecord);
router.get('/records/owner/:address', listByOwner);
router.get('/records/:tokenId', getRecord);

// --- Releases a record, or a reading of one. ---

// Consent-gated: the requester must be entitled to read the record. The contract
// answers, the server never guesses.
router.get('/records/:tokenId/file', requireConsent, releaseFile);

// Metadata-only audit view, and the free public verification primitive.
router.get('/audit/:tokenId', audit);
router.post('/verify', verify);

export default router;
