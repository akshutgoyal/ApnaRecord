import { ethers } from 'ethers';
import { RecordModel, isDbReady } from '../models/index.js';
import { recordMeta, tokensOf, call } from '../services/chain.js';
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

/**
 * GET /api/records
 * The browse index. MongoDB when it is up; otherwise rebuilt from chain logs on
 * the spot — which is the whole point of calling the database a cache.
 */
export async function listRecords(req, res) {
  try {
    if (isDbReady()) {
      const docs = await RecordModel.find().sort({ tokenId: 1 }).lean();
      if (docs.length > 0) {
        return res.json({
          source: 'database',
          records: docs.map((d) => ({
            tokenId: d.tokenId,
            patient: d.patient,
            recordType: d.recordType,
            recordHash: d.recordHash,
            cid: d.cid,
            fileName: d.fileName,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            locked: true,
            burned: false,
            mintedAtBlock: d.mintedAtBlock,
            mintedTx: d.mintedTx,
          })),
        });
      }
    }

    const nextTokenId = Number((await call('nextTokenId'))[0]);
    const records = [];
    for (let tokenId = 1; tokenId < nextTokenId; tokenId++) {
      const meta = await recordMeta(tokenId);
      if (!meta) continue;
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
    if (isDbReady()) cached = await RecordModel.findOne({ tokenId }).lean();
    if (!cached && !(await hasBlob(meta.recordHash))) {
      // The token exists on-chain but this server never held the bytes.
      meta.blobMissing = true;
    }
    return res.json({ ...meta, cached: Boolean(cached) });
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
    return res.json({ address, records: tokens });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/**
 * POST /api/records
 * Store a record the BROWSER already encrypted. The server receives ciphertext,
 * seals the content key, and never sees the plaintext at rest.
 *
 * Body: { tokenId, patient, recordType, fileName, mimeType, contentKey, ciphertext }
 *       contentKey  — hex, 32 bytes, generated in the browser
 *       ciphertext  — base64 of `iv || ciphertext || tag`
 */
export async function storeRecord(req, res) {
  try {
    const { tokenId, patient, recordType, fileName, mimeType, contentKey, ciphertext, cid } =
      req.body || {};

    if (!Number.isInteger(Number(tokenId)) || Number(tokenId) <= 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'tokenId is required.' });
    }
    if (typeof contentKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(contentKey)) {
      return res.status(400).json({ error: 'BadRequest', message: 'contentKey must be 32 bytes of hex.' });
    }
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'ciphertext is required.' });
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

    // The digest the browser put on-chain must be keccak256 of these exact bytes.
    const digest = ethers.keccak256(payload);

    const { stored } = await putBlob(digest, payload);
    await putSealedKey(digest, sealKey(contentKey));

    if (isDbReady()) {
      await RecordModel.findOneAndUpdate(
        { tokenId: Number(tokenId) },
        {
          tokenId: Number(tokenId),
          patient: String(patient || '').toLowerCase(),
          recordType: recordType || 'UNSPECIFIED',
          recordHash: digest,
          cid: cid || '',
          sealedKey: '(on disk)',
          fileName: fileName || 'record.bin',
          mimeType: mimeType || 'application/octet-stream',
          sizeBytes: payload.length,
        },
        { upsert: true, new: true }
      );
    }

    return res.status(201).json({
      ok: true,
      tokenId: Number(tokenId),
      recordHash: digest,
      sizeBytes: payload.length,
      alreadyStored: !stored,
      cachedInDatabase: isDbReady(),
    });
  } catch (error) {
    return res.status(500).json({ error: 'StorageFailed', message: error.message });
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
      fileMeta = await RecordModel.findOne({ tokenId }).lean().catch(() => null);
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
