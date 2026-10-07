import { createDecipheriv } from 'node:crypto';
import { ethers } from 'ethers';
import { RecordModel, UploadStageModel, isDbReady } from '../models/index.js';
import {
  recordMeta,
  tokensOf,
  call,
  verifyRecord,
  getProvider,
  getAddress as getContractAddress,
  getInterface,
} from '../services/chain.js';
import { entitledPatients } from '../middleware/requireWallet.js';
import {
  claimOneUseNonce,
  signedWriteDomain,
  verifyDeadlineMessage,
} from '../lib/signature.js';
import {
  putBlob,
  putSealedKey,
  hasBlob,
  getBlob,
  getSealedKey,
  openKey,
  sealKey,
} from '../services/storage.js';

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB of ciphertext per request
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const UPLOAD_STAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Authenticate and hash the browser's AES-GCM payload with its submitted key. */
function decryptPayloadHash(payload, contentKeyHex) {
  if (payload.length < GCM_IV_BYTES + GCM_TAG_BYTES) return null;

  try {
    const iv = payload.subarray(0, GCM_IV_BYTES);
    const encrypted = payload.subarray(GCM_IV_BYTES, payload.length - GCM_TAG_BYTES);
    const tag = payload.subarray(payload.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(contentKeyHex, 'hex'), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return ethers.keccak256(plaintext);
  } catch {
    return null;
  }
}

/**
 * Canonical hash and statement an uploader signs. These must stay byte-identical to
 * `client/src/lib/wireMessages.js`; integration coverage compares both sides because
 * drift makes every upload look like a broken permissions system.
 */
export function storePayloadHash({
  actor,
  uploadId,
  tokenId,
  patient,
  recordHash,
  recordType,
  fileName,
  mimeType,
  contentKey,
  cid,
  plainHash,
}) {
  const values = [
    ethers.getAddress(actor),
    String(uploadId).toLowerCase(),
    tokenId == null || tokenId === '' ? '' : Number(tokenId),
    ethers.getAddress(patient),
    String(recordHash).toLowerCase(),
    String(recordType || 'UNSPECIFIED'),
    String(fileName || 'record.bin'),
    String(mimeType || 'application/octet-stream'),
    String(contentKey).toLowerCase(),
    String(cid || ''),
    String(plainHash || '').toLowerCase(),
  ];
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(values)));
}

export function storeMessage(
  { actor, uploadId, tokenId, patient, recordHash, deadline, nonce, ...payload },
  domain = signedWriteDomain()
) {
  const dataHash = storePayloadHash({ actor, uploadId, tokenId, patient, recordHash, ...payload });
  return (
    'ApnaRecord store record\n' +
    `chainId: ${domain.chainId}\n` +
    `verifyingContract: ${domain.verifyingContract}\n` +
    `actor: ${ethers.getAddress(actor)}\n` +
    `uploadId: ${String(uploadId).toLowerCase()}\n` +
    `tokenId: ${tokenId == null || tokenId === '' ? 'staged' : Number(tokenId)}\n` +
    `patient: ${ethers.getAddress(patient)}\n` +
    `recordHash: ${String(recordHash).toLowerCase()}\n` +
    `payloadHash: ${dataHash}\n` +
    `deadline: ${deadline}\n` +
    `nonce: ${String(nonce).toLowerCase()}`
  );
}

/**
 * GET /api/records
 * The browse index. MongoDB when it is up; otherwise rebuilt from chain logs on
 * the spot — which is the whole point of calling the database a cache.
 *
 * ?facility=<it> scopes to the patients currently linked to that hospital.
 * The link set itself needs the database; the records underneath resolve from
 * whichever source serves them.
 */
export async function listRecords(req, res) {
  try {
    const facility = (req.query.facility || '').trim();
    let scope = null;
    if (facility) {
      try {
        const { linkedPatientsOf } = await import('../lib/facilityScope.js');
        scope = new Set((await linkedPatientsOf(facility)).map((p) => p.toLowerCase()));
      } catch (error) {
        return res
          .status(error.status || 500)
          .json({ error: error.error || 'ScopeFailed', message: error.message });
      }
    }
    const inScope = (patient) => !scope || (patient && scope.has(String(patient).toLowerCase()));

    // Which rows may carry their off-chain fields — file name, MIME type, record type.
    // An anonymous caller enumerating tokens is reading what the chain already publishes:
    // an id, a digest, an owner, a block. A block explorer shows exactly that. The rest
    // is what the contract deliberately refused to carry, and it attaches only for a
    // viewer entitled to it.
    //
    // Fails CLOSED: if entitlement cannot be established, the caller gets the on-chain
    // half. An empty Set, not null — null means "all", and a chain hiccup must never
    // be what grants it.
    const entitled = req.viewer
      ? await entitledPatients(req.viewer).catch(() => new Set())
      : new Set();
    const maySeeOffChain = (patient) => !entitled || entitled.has(String(patient).toLowerCase());

    if (isDbReady()) {
      const docs = await RecordModel.find().sort({ tokenId: 1 }).lean();
      // Rows created by the older predicted-token upload flow can have a tokenId
      // before the chain has ever minted it. They have no mint transaction and
      // must never become a browse result. Falling through lets the chain decide.
      const confirmedChainRows = docs.filter((d) => d.mintedTx);
      if (confirmedChainRows.length > 0 && confirmedChainRows.length === docs.length) {
        return res.json({
          source: 'database',
          ...(scope ? { facility: facility.toLowerCase(), scoped: true } : {}),
          records: confirmedChainRows
            .filter((d) => inScope(d.patient))
            .map((d) => ({
              tokenId: d.tokenId,
              patient: d.patient,
              recordHash: d.recordHash,
              // Spread only when entitled, so an anonymous caller cannot even see the keys —
              // a null field would still tell them a file name exists.
              ...(d.metadataConfirmed && maySeeOffChain(d.patient)
                ? {
                    recordType: d.recordType,
                    cid: d.cid,
                    fileName: d.fileName,
                    mimeType: d.mimeType,
                    sizeBytes: d.sizeBytes,
                  }
                : {}),
              locked: true,
              // Not hardcoded. `revokeRecord` burns the token but the row stays, so a
              // constant `false` here presented revoked records as live on the browse
              // index — and every dashboard renders `burned`, so they all showed the
              // wrong state. The chain branch below reads the real value; this one now
              // does too.
              burned: Boolean(d.burned),
              mintedAtBlock: d.mintedAtBlock,
              mintedTx: d.mintedTx,
            })),
        });
      }
    }

    // No cached rows (or no database racing us): fall through to the chain path, which
    // resolves owners and applies the same scope below rather than refusing the read.
    const nextTokenId = Number((await call('nextTokenId'))[0]);
    const records = [];
    for (let tokenId = 1; tokenId < nextTokenId; tokenId++) {
      const meta = await recordMeta(tokenId);
      if (!meta) continue;
      if (!inScope(meta.patient)) continue;
      records.push({
        tokenId: meta.tokenId,
        patient: meta.patient,
        recordType: meta.recordType,
        recordHash: meta.recordHash,
        locked: meta.locked,
        burned: meta.burned,
        mintedAtBlock: meta.mintedAtBlock,
        mintedTx: meta.mintedTx,
      });
    }
    return res.json({
      source: 'chain',
      note: 'Rebuilt from RecordMinted logs. Start MongoDB to use the fast index.',
      ...(scope ? { facility: facility.toLowerCase(), scoped: true } : {}),
      records,
    });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/** GET /api/records/:tokenId — metadata as the chain sees it. */
export async function getRecord(req, res) {
  const tokenId = Number(req.params.tokenId);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return res.status(400).json({ error: 'BadRequest', message: 'tokenId must be a positive integer.' });
  }
  try {
    const meta = await recordMeta(tokenId);
    if (!meta) return res.status(404).json({ error: 'RecordNotFound', message: 'No such record.' });

    let cached = null;
    if (isDbReady()) {
      cached = await RecordModel.findOne({
        tokenId,
        recordHash: String(meta.recordHash).toLowerCase(),
        mintedTx: String(meta.mintedTx || '').toLowerCase(),
        metadataConfirmed: true,
      }).lean();
    }
    if (!cached && !(await hasBlob(meta.recordHash))) {
      // The token exists on-chain but this server never held the bytes.
      meta.blobMissing = true;
    }
    // The same line as the list. `recordType` is off-chain — the contract deliberately
    // refuses to carry clinical categories on a public log — so it goes only to a viewer
    // the chain says may see this patient: the patient, an admin or auditor, or a facility
    // linked to them. Everyone else gets the on-chain half, which a block explorer would
    // show them anyway.
    const { mayReadSubject } = await import('../middleware/requireWallet.js');
    const subjectEntitlement = req.viewer
      ? await mayReadSubject(req.viewer, meta.patient).catch(() => false)
      : false;
    const consentEntitlement = req.viewer
      ? await call('canAccess', [tokenId, req.viewer])
          .then((result) => Boolean(result?.[0]))
          .catch(() => false)
      : false;
    const entitledToIt = subjectEntitlement || consentEntitlement;
    
    if (entitledToIt) return res.json({ ...meta, cached: Boolean(cached) });
    
    const { recordType, ...onChain } = meta;
    return res.json({ ...onChain, cached: Boolean(cached) });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/** GET /api/records/owner/:address */
export async function listByOwner(req, res) {
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  try {
    const tokens = await tokensOf(address);

    // The tokens come off the chain, so the list itself is public -- `RecordMinted`
    // carries the id and the digest, and anyone can scan it. What is NOT on chain is the
    // record type, which is exactly why it lives in the database.
    //
    // So the same shape as the platform list: the chain fields for everyone, the type only
    // for a viewer entitled to this patient. An anonymous reader -- the demo persona -- gets
    // a record that exists rather than an empty list, which is what a hard gate produced.
    const { entitledPatients } = await import('../middleware/requireWallet.js');
    const entitled = req.viewer
      ? await entitledPatients(req.viewer).catch(() => new Set())
      : new Set();
    const maySeeType = !entitled || entitled.has(String(address).toLowerCase());

    const records = maySeeType
      ? tokens
      : tokens.map(({ recordType, facility, ...onChain }) => onChain);

    return res.json({ address, records, clinicalFields: maySeeType });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/**
 * POST /api/records
 * Store browser-encrypted bytes. New mints are staged by a random upload ID and
 * are not inserted into the public record cache until /records/confirm verifies
 * the successful receipt and the RecordMinted event it contains.
 */
export async function storeRecord(req, res) {
  try {
    const {
      uploadId,
      actor,
      tokenId,
      patient,
      recordType,
      fileName,
      mimeType,
      contentKey,
      ciphertext,
      cid,
      plainHash,
      deadline,
      nonce,
      signature,
    } = req.body || {};
    const hasTokenId = tokenId !== undefined && tokenId !== null && tokenId !== '';
    const normalizedTokenId = hasTokenId ? Number(tokenId) : null;

    if (typeof uploadId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(uploadId)) {
      return res.status(400).json({ error: 'BadRequest', message: 'uploadId must be 32 bytes of hex.' });
    }
    if (hasTokenId && (!Number.isSafeInteger(normalizedTokenId) || normalizedTokenId <= 0)) {
      return res.status(400).json({ error: 'BadRequest', message: 'tokenId must be a positive safe integer when repairing an existing record.' });
    }
    if (typeof contentKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(contentKey)) {
      return res.status(400).json({ error: 'BadRequest', message: 'contentKey must be 32 bytes of hex.' });
    }
    if (plainHash != null && plainHash !== '' && !/^0x[0-9a-fA-F]{64}$/.test(plainHash)) {
      return res.status(400).json({ error: 'BadRequest', message: 'plainHash must be 0x + 64 hex chars.' });
    }
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'ciphertext is required.' });
    }
    if (!ethers.isAddress(actor)) {
      return res.status(400).json({ error: 'BadRequest', message: 'actor must be a wallet or account address.' });
    }
    if (!ethers.isAddress(patient)) {
      return res.status(400).json({ error: 'BadRequest', message: 'patient must be a wallet address.' });
    }
    if (!deadline || !nonce || !signature) {
      return res.status(400).json({ error: 'SignatureRequired', message: 'A signed statement from the acting account is required.' });
    }

    for (const [field, value, maxLength] of [
      ['recordType', recordType, 60],
      ['fileName', fileName, 255],
      ['mimeType', mimeType, 128],
      ['cid', cid, 256],
    ]) {
      if (value != null && typeof value !== 'string') {
        return res.status(400).json({ error: 'BadRequest', message: `${field} must be text.` });
      }
      if (typeof value === 'string' && value.length > maxLength) {
        return res.status(400).json({ error: 'BadRequest', message: `${field} must be at most ${maxLength} characters.` });
      }
    }

    const payload = Buffer.from(ciphertext, 'base64');
    if (payload.length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'ciphertext did not decode.' });
    }
    if (payload.length > MAX_BYTES) {
      return res.status(413).json({
        error: 'PayloadTooLarge',
        message: `This demo store accepts up to ${MAX_BYTES / 1024 / 1024} MB.`,
      });
    }

    const digest = ethers.keccak256(payload);
    const signedPayload = {
      uploadId: uploadId.toLowerCase(),
      actor: ethers.getAddress(actor),
      tokenId: normalizedTokenId,
      patient: ethers.getAddress(patient),
      recordHash: digest,
      recordType: recordType || 'UNSPECIFIED',
      fileName: fileName || 'record.bin',
      mimeType: mimeType || 'application/octet-stream',
      contentKey: contentKey.toLowerCase(),
      cid: cid || '',
      plainHash: String(plainHash || '').toLowerCase(),
    };

    const statement = storeMessage({ ...signedPayload, deadline, nonce });
    const authorization = await verifyDeadlineMessage({
      message: statement,
      address: actor,
      deadline,
      nonce,
      signature,
    });
    if (authorization.error) {
      return res.status(403).json({ error: 'SignatureInvalid', message: authorization.error });
    }
    if (
      !hasTokenId &&
      signedPayload.cid !== `sha256:${digest.slice(2)}:upload:${signedPayload.uploadId.slice(2)}`
    ) {
      return res.status(400).json({
        error: 'UploadBindingMismatch',
        message: 'A staged upload CID must bind its content digest to its uploadId.',
      });
    }

    let minterFacility = '';
    let existingMeta = null;
    if (hasTokenId) {
      existingMeta = await recordMeta(normalizedTokenId);
      if (!existingMeta) {
        return res.status(404).json({ error: 'RecordNotFound', message: `Token ${normalizedTokenId} has not been minted.` });
      }
      if (!existingMeta.patient) {
        return res.status(409).json({ error: 'RecordRevoked', message: `Token ${normalizedTokenId} has been revoked.` });
      }
      if (actor.toLowerCase() !== String(existingMeta.patient).toLowerCase()) {
        return res.status(403).json({
          error: 'NotRecordOwner',
          message: `Token ${normalizedTokenId} is owned by ${existingMeta.patient}; its owner account must authorize this upload.`,
        });
      }
      if (String(existingMeta.patient).toLowerCase() !== signedPayload.patient.toLowerCase()) {
        return res.status(409).json({
          error: 'PatientMismatch',
          message: `Token ${normalizedTokenId} belongs to ${existingMeta.patient}, not ${patient}. The chain is the authority here.`,
        });
      }
      if (String(existingMeta.recordHash).toLowerCase() !== digest.toLowerCase()) {
        return res.status(409).json({ error: 'DigestMismatch', message: 'These bytes do not hash to the digest recorded on-chain for this token.' });
      }
      const [matches] = await verifyRecord(normalizedTokenId, digest);
      if (!matches) {
        return res.status(409).json({
          error: 'DigestMismatch',
          message: 'These bytes do not hash to the digest recorded on-chain for this token.',
        });
      }
      minterFacility = existingMeta?.facility || '';
    } else {
      // Pre-mint uploads need durable staging metadata. Without MongoDB the client
      // must stop before minting rather than create a token with unbindable metadata.
      if (!isDbReady()) {
        return res.status(503).json({
          error: 'UploadStageUnavailable',
          message: 'Upload staging is unavailable while the database is offline; no mint should be submitted yet.',
        });
      }

      const [adminRole] = await call('DEFAULT_ADMIN_ROLE');
      const [isAdmin] = await call('hasRole', [adminRole, actor]);
      if (!isAdmin) {
        const [hospitalRole] = await call('HOSPITAL_ROLE');
        const [isHospital] = await call('hasRole', [hospitalRole, actor]);
        let linked = false;
        if (isHospital) {
          try {
            const [flag] = await call('facilityPatient', [actor, patient]);
            linked = Boolean(flag);
          } catch {
            linked = false;
          }
        }
        if (!linked) {
          return res.status(403).json({
            error: 'NotMintingRole',
            message: 'The uploader must be a platform admin or a hospital currently linked to this patient.',
          });
        }
        minterFacility = actor.toLowerCase();
      }
    }

    const plainDigest = decryptPayloadHash(payload, signedPayload.contentKey);
    if (!plainDigest) {
      return res.status(400).json({
        error: 'ContentKeyMismatch',
        message: 'The content key does not authenticate this AES-GCM ciphertext.',
      });
    }
    if (signedPayload.plainHash && plainDigest.toLowerCase() !== signedPayload.plainHash) {
      return res.status(400).json({
        error: 'PlainHashMismatch',
        message: 'plainHash does not match the plaintext authenticated by this content key.',
      });
    }

    const claim = await claimOneUseNonce({ bucket: 'signed-write', address: actor, deadline, nonce });
    if (claim) return res.status(claim.status).json({ error: claim.code, message: claim.error });

    const { stored } = await putBlob(digest, payload);
    await putSealedKey(digest, sealKey(signedPayload.contentKey));

    if (hasTokenId) {
      await RecordModel.findOneAndUpdate(
        { tokenId: normalizedTokenId },
        {
          $set: {
            tokenId: normalizedTokenId,
            patient: signedPayload.patient.toLowerCase(),
            recordType: signedPayload.recordType,
            recordHash: digest,
            plainHash: signedPayload.plainHash,
            cid: signedPayload.cid,
            sealedKey: '(on disk)',
            fileName: signedPayload.fileName,
            mimeType: signedPayload.mimeType,
            sizeBytes: payload.length,
            facility: minterFacility,
            ...(existingMeta
              ? {
                  mintedAtBlock: existingMeta.mintedAtBlock,
                  mintedTx: String(existingMeta.mintedTx || '').toLowerCase(),
                }
              : {}),
            uploadId: signedPayload.uploadId,
            metadataConfirmed: true,
            burned: false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
      );
    } else {
      await UploadStageModel.create({
        uploadId: signedPayload.uploadId,
        actor: signedPayload.actor.toLowerCase(),
        patient: signedPayload.patient.toLowerCase(),
        recordType: signedPayload.recordType,
        recordHash: digest,
        plainHash: signedPayload.plainHash,
        cid: signedPayload.cid,
        sealedKey: '(on disk)',
        fileName: signedPayload.fileName,
        mimeType: signedPayload.mimeType,
        sizeBytes: payload.length,
        facility: minterFacility,
        expiresAt: new Date(Date.now() + UPLOAD_STAGE_TTL_MS),
      });
    }

    return res.status(201).json({
      ok: true,
      uploadId: signedPayload.uploadId,
      ...(hasTokenId ? { tokenId: normalizedTokenId, staged: false } : { staged: true }),
      recordHash: digest,
      sizeBytes: payload.length,
      alreadyStored: !stored,
      cachedInDatabase: isDbReady(),
      verified: hasTokenId
        ? 'The owner signature and the existing chain record were checked against these bytes.'
        : 'The signed upload and minting role were checked. The metadata remains staged until a successful mint receipt is confirmed.',
    });
  } catch (error) {
    if (error?.code === 'CONTENT_KEY_CONFLICT') {
      return res.status(409).json({ error: 'ContentKeyConflict', message: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'UploadIdUsed', message: 'This uploadId has already been used.' });
    }
    return res.status(500).json({ error: 'StorageFailed', message: error.message });
  }
}

/**
 * POST /api/records/confirm
 * Bind one staged upload to the token actually minted by a successful transaction.
 */
export async function confirmRecordUpload(req, res) {
  try {
    const uploadId = String(req.body?.uploadId || '').toLowerCase();
    const txHash = String(req.body?.txHash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(uploadId) || !/^0x[0-9a-f]{64}$/.test(txHash)) {
      return res.status(400).json({
        error: 'BadRequest',
        message: 'uploadId and txHash must each be 32 bytes of hex.',
      });
    }
    if (!isDbReady()) {
      return res.status(503).json({ error: 'UploadStageUnavailable', message: 'Upload staging is unavailable while the database is offline.' });
    }

    const stage = await UploadStageModel.findOne({ uploadId }).lean();
    if (!stage || new Date(stage.expiresAt).getTime() <= Date.now()) {
      return res.status(404).json({ error: 'UploadStageNotFound', message: 'This staged upload is missing or expired.' });
    }
    if (stage.status === 'confirmed' && String(stage.mintedTx).toLowerCase() !== txHash) {
      return res.status(409).json({ error: 'UploadAlreadyConfirmed', message: 'This upload is already bound to a different mint transaction.' });
    }

    const receipt = await getProvider().getTransactionReceipt(txHash);
    if (!receipt) {
      return res.status(409).json({ error: 'MintNotConfirmed', message: 'The mint transaction has no confirmed receipt yet. Retry after it is mined.' });
    }
    if (String(receipt.hash || receipt.transactionHash || '').toLowerCase() !== txHash) {
      return res.status(409).json({ error: 'MintReceiptMismatch', message: 'The node returned a receipt for a different transaction.' });
    }
    if (Number(receipt.status) !== 1) {
      return res.status(409).json({ error: 'MintFailed', message: 'The mint transaction did not succeed.' });
    }
    const network = await getProvider().getNetwork();
    if (Number(network.chainId) !== Number(process.env.CHAIN_ID)) {
      return res.status(503).json({ error: 'ChainMismatch', message: 'The configured RPC is connected to a different chain.' });
    }

    const contractAddress = getContractAddress().toLowerCase();
    const iface = getInterface();
    const transaction = await getProvider().getTransaction(txHash);
    if (!transaction) {
      return res.status(409).json({ error: 'MintTransactionUnavailable', message: 'The mint transaction data is not available yet.' });
    }
    if (String(transaction.hash || '').toLowerCase() !== txHash) {
      return res.status(409).json({ error: 'MintTransactionMismatch', message: 'The node returned transaction data for a different hash.' });
    }
    let callTarget = String(transaction.to || '').toLowerCase();
    let callData = transaction.data;
    let issuer = String(transaction.from || '').toLowerCase();
    if (callTarget !== contractAddress) {
      const accountInterface = new ethers.Interface([
        'function execute(address target, uint256 value, bytes data) returns (bytes)',
      ]);
      let accountCall;
      try {
        accountCall = accountInterface.parseTransaction({ data: callData });
      } catch {
        accountCall = null;
      }
      if (accountCall?.name !== 'execute') {
        return res.status(409).json({ error: 'MintCallMismatch', message: 'The receipt transaction did not call the record contract mint function.' });
      }
      issuer = callTarget;
      callTarget = String(accountCall.args.target).toLowerCase();
      callData = accountCall.args.data;
    }
    if (issuer !== String(stage.actor).toLowerCase()) {
      return res.status(409).json({ error: 'MintIssuerMismatch', message: 'The mint transaction was not submitted by the account that signed this staged upload.' });
    }
    let mintCall;
    try {
      if (callTarget === contractAddress) mintCall = iface.parseTransaction({ data: callData });
    } catch {
      mintCall = null;
    }
    if (
      mintCall?.name !== 'mintRecord' ||
      String(mintCall.args.patient).toLowerCase() !== String(stage.patient).toLowerCase() ||
      String(mintCall.args.recordHash).toLowerCase() !== String(stage.recordHash).toLowerCase() ||
      String(mintCall.args.cid) !== String(stage.cid)
    ) {
      return res.status(409).json({ error: 'MintCallMismatch', message: 'The mint call does not match the patient, digest, and upload identifier in this stage.' });
    }

    const mintedEvents = [];
    for (const log of receipt.logs || []) {
      if (String(log.address || '').toLowerCase() !== contractAddress) continue;
      if (log.transactionHash && String(log.transactionHash).toLowerCase() !== txHash) continue;
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'RecordMinted') mintedEvents.push(parsed);
      } catch {
        /* a log from this contract can be a different event */
      }
    }
    const matchingEvents = mintedEvents.filter(
      (event) => String(event.args.recordHash).toLowerCase() === String(stage.recordHash).toLowerCase()
    );
    if (matchingEvents.length !== 1) {
      return res.status(409).json({ error: 'MintReceiptMismatch', message: 'The receipt must contain exactly one RecordMinted event for these staged bytes.' });
    }
    const tokenId = Number(matchingEvents[0].args.tokenId);
    if (!Number.isSafeInteger(tokenId) || tokenId <= 0) {
      return res.status(409).json({ error: 'MintReceiptMismatch', message: 'The receipt contains an invalid token ID.' });
    }

    const [owner] = await call('ownerOf', [tokenId]);
    if (String(owner).toLowerCase() !== String(stage.patient).toLowerCase()) {
      return res.status(409).json({ error: 'MintPatientMismatch', message: 'The minted token is not owned by the patient named in the staged upload.' });
    }
    const [digestMatches] = await verifyRecord(tokenId, stage.recordHash);
    if (!digestMatches) {
      return res.status(409).json({ error: 'MintDigestMismatch', message: 'The chain does not bind this token to the staged ciphertext digest.' });
    }

    // The conditional claim makes a random upload ID a one-mint capability even
    // when two API instances receive competing confirmations concurrently.
    const claimed = await UploadStageModel.findOneAndUpdate(
      { uploadId, status: 'staged' },
      { $set: { status: 'confirmed', tokenId, mintedTx: txHash } },
      { new: true }
    );
    if (!claimed) {
      const current = await UploadStageModel.findOne({ uploadId }).lean();
      if (
        !current ||
        current.status !== 'confirmed' ||
        Number(current.tokenId) !== tokenId ||
        String(current.mintedTx).toLowerCase() !== txHash
      ) {
        return res.status(409).json({ error: 'UploadAlreadyConfirmed', message: 'This upload is already bound to a different mint.' });
      }
    }

    const mintedTx = txHash;
    try {
      await RecordModel.findOneAndUpdate(
        { tokenId },
        {
          $set: {
            tokenId,
            patient: String(stage.patient).toLowerCase(),
            recordType: stage.recordType,
            recordHash: String(stage.recordHash).toLowerCase(),
            plainHash: stage.plainHash || '',
            cid: stage.cid || '',
            sealedKey: stage.sealedKey || '(on disk)',
            fileName: stage.fileName || 'record.bin',
            mimeType: stage.mimeType || 'application/octet-stream',
            sizeBytes: stage.sizeBytes || 0,
            facility: stage.facility || '',
            mintedAtBlock: Number(receipt.blockNumber),
            mintedTx,
            uploadId,
            metadataConfirmed: true,
            burned: false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
      );
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({ error: 'RecordCacheConflict', message: 'The verified mint conflicts with an existing record cache entry.' });
      }
      throw error;
    }

    return res.json({
      ok: true,
      uploadId,
      tokenId,
      recordHash: String(stage.recordHash).toLowerCase(),
      mintedTx,
      cachedInDatabase: true,
    });
  } catch (error) {
    return res.status(500).json({ error: 'UploadConfirmationFailed', message: error.message });
  }
}

/**
 * GET /api/records/:tokenId/file
 * Behind requireConsent. Releases ONLY what the record owner, or the contract,
 * has authorised: the ciphertext and — for our documented demo key model — the
 * content key needed to read it.
 */
export async function releaseFile(req, res) {
  const { tokenId, viewer, cid } = req.consent;
  try {
    const meta = await recordMeta(tokenId);
    if (!meta) return res.status(404).json({ error: 'RecordNotFound', message: 'No such record.' });

    const digest = meta.recordHash;
    if (!(await hasBlob(digest))) {
      return res.status(409).json({
        error: 'BlobMissing',
        message:
          'The chain holds this record but this server does not hold its bytes. ' +
          'It was minted from a different machine or the uploads directory was cleared.',
        recordHash: digest,
      });
    }

    const [ciphertext, sealed] = await Promise.all([getBlob(digest), getSealedKey(digest)]);

    // The original filename and MIME type live only in the cache, because a chain
    // cannot hold them — and they matter: without them the browser cannot offer to
    // download a scan under a name anyone would recognise.
    let fileMeta = null;
    if (isDbReady()) {
      fileMeta = await RecordModel.findOne({
        tokenId,
        recordHash: String(digest).toLowerCase(),
        mintedTx: String(meta.mintedTx || '').toLowerCase(),
        metadataConfirmed: true,
      }).lean().catch(() => null);
    }

    return res.json({
      tokenId,
      viewer,
      // The CID the CONTRACT released, not one we looked up ourselves.
      cid,
      recordHash: digest,
      recordType: meta.recordType,
      patient: meta.patient,
      fileName: fileMeta?.fileName || null,
      mimeType: fileMeta?.mimeType || null,
      contentKey: openKey(sealed),
      ciphertext: ciphertext.toString('base64'),
      sizeBytes: ciphertext.length,
      checkedBy: 'contract.viewRecord',
    });
  } catch (error) {
    return res.status(500).json({ error: 'ReleaseFailed', message: error.message });
  }
}
