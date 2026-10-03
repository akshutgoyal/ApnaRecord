import { ethers } from 'ethers';
import { RecordModel, isDbReady } from '../models/index.js';
import { recordMeta, tokensOf, call, verifyRecord } from '../services/chain.js';
import { entitledPatients } from '../middleware/requireWallet.js';
import { verifyStatement, recoverStatement } from '../lib/signature.js';
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
 * The statement an uploader signs.
 *
 * Must stay byte-identical to `client/src/lib/wireMessages.js` `storeMessage`. The two
 * deploy separately so it is duplicated rather than imported, and the test suite
 * asserts they agree — drift here means every upload is refused and the failure looks
 * like a broken permissions system.
 */
export function storeMessage(tokenId, patient, recordHash, timestamp) {
  return (
    'ApnaRecord store record\n' +
    `tokenId: ${Number(tokenId)}\n` +
    `patient: ${ethers.getAddress(patient)}\n` +
    `recordHash: ${String(recordHash).toLowerCase()}\n` +
    `timestamp: ${timestamp}`
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
      if (docs.length > 0) {
        return res.json({
          source: 'database',
          ...(scope ? { facility: facility.toLowerCase(), scoped: true } : {}),
          records: docs
            .filter((d) => inScope(d.patient))
            .map((d) => ({
              tokenId: d.tokenId,
              patient: d.patient,
              recordHash: d.recordHash,
              // Spread only when entitled, so an anonymous caller cannot even see the keys —
              // a null field would still tell them a file name exists.
              ...(maySeeOffChain(d.patient)
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
    if (isDbReady()) cached = await RecordModel.findOne({ tokenId }).lean();
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
    const entitledToIt = req.viewer
      ? await mayReadSubject(req.viewer, meta.patient).catch(() => false)
      : false;
    
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
 * Store a record the BROWSER already encrypted. The server receives ciphertext,
 * seals the content key, and never sees the plaintext at rest.
 *
 * Body: { tokenId, patient, recordType, fileName, mimeType, contentKey, ciphertext }
 *       contentKey  — hex, 32 bytes, generated in the browser
 *       ciphertext  — base64 of `iv || ciphertext || tag`
 */
export async function storeRecord(req, res) {
  try {
    const {
      tokenId,
      patient,
      recordType,
      fileName,
      mimeType,
      contentKey,
      ciphertext,
      cid,
      plainHash,
      timestamp,
      signature,
    } = req.body || {};

    if (!Number.isInteger(Number(tokenId)) || Number(tokenId) <= 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'tokenId is required.' });
    }
    if (typeof contentKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(contentKey)) {
      return res.status(400).json({ error: 'BadRequest', message: 'contentKey must be 32 bytes of hex.' });
    }
    // Optional, and only used by the public verify page. A plaintext digest is a hash,
    // not a file, so accepting it does not put the scan anywhere near the server.
    if (plainHash != null && plainHash !== '' && !/^0x[0-9a-fA-F]{64}$/.test(plainHash)) {
      return res.status(400).json({ error: 'BadRequest', message: 'plainHash must be 0x + 64 hex chars.' });
    }
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'ciphertext is required.' });
    }
    // Validated before it is used to build a signed message, because getting this
    // wrong throws inside message construction and would surface as a 500.
    if (!ethers.isAddress(patient)) {
      return res.status(400).json({ error: 'BadRequest', message: 'patient must be a wallet address.' });
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

    // ---------------------------------------------------------------------
    // WHO IS ASKING, AND WHETHER THE CHAIN AGREES.
    //
    // This endpoint used to accept anything: an unauthenticated caller could write a
    // row naming any token and any patient. The bytes are still stored before the
    // token is minted — deliberately, since a token whose bytes nobody holds is worse
    // than no token — so there are two cases and they need different evidence.
    //
    //   • The token EXISTS. This is a re-upload or a repair. The contract's owner
    //     signs, and the bytes must hash to what the chain already recorded.
    //
    //   • The token does NOT exist yet. This is the ordinary mint flow. Only an
    //     account holding DEFAULT_ADMIN_ROLE can mint it, so only such an account may
    //     store its bytes — and only for the token actually next in line, so an
    //     upload cannot be parked against some future id.
    // ---------------------------------------------------------------------
    let onChainOwner = null;
    try {
      const [owner] = await call('ownerOf', [Number(tokenId)]);
      onChainOwner = owner;
    } catch {
      // Reverts for a token that does not exist yet, which is a legitimate state here
      // rather than an error. Anything else would have thrown further up.
      onChainOwner = null;
    }

    const statement = storeMessage(Number(tokenId), patient, digest, timestamp);

    // The facility that staged these bytes, for the hospital read scope.
    // The platform mints anywhere and stamps nothing.
    let minterFacility = '';

    if (onChainOwner) {
      const problem = verifyStatement({
        message: statement,
        address: onChainOwner,
        timestamp,
        signature,
      });
      if (problem) {
        return res.status(403).json({ error: 'SignatureInvalid', message: problem });
      }

      if (onChainOwner.toLowerCase() !== String(patient).toLowerCase()) {
        return res.status(409).json({
          error: 'PatientMismatch',
          message: `Token ${tokenId} belongs to ${onChainOwner}, not ${patient}. The chain is the authority here.`,
        });
      }

      const [matches] = await verifyRecord(Number(tokenId), digest);
      if (!matches) {
        return res.status(409).json({
          error: 'DigestMismatch',
          message:
            'These bytes do not hash to the digest recorded on-chain for this token, so storing ' +
            'them would attach the wrong document to a medical record.',
        });
      }
    } else {
      const recovered = recoverStatement({ message: statement, timestamp, signature });
      if (recovered.error) {
        return res.status(403).json({ error: 'SignatureInvalid', message: recovered.error });
      }

      const [nextId] = await call('nextTokenId');
      if (Number(tokenId) !== Number(nextId)) {
        return res.status(400).json({
          error: 'NotNextToken',
          message: `Token ${tokenId} does not exist and is not next in line (${nextId}). Bytes can only be stored ahead of the mint that will create them.`,
        });
      }

      const [adminRole] = await call('DEFAULT_ADMIN_ROLE');
      const [isAdmin] = await call('hasRole', [adminRole, recovered.signer]);
      if (!isAdmin) {
        // A hospital may stage bytes for a patient it is currently linked to —
        // the same gate as `mintRecord` on-chain, re-checked here so a row
        // cannot be parked for a mint the chain would refuse.
        const [hospitalRole] = await call('HOSPITAL_ROLE');
        const [isHospital] = await call('hasRole', [hospitalRole, recovered.signer]);
        let linked = false;
        if (isHospital) {
          try {
            const [flag] = await call('facilityPatient', [recovered.signer, patient]);
            linked = Boolean(flag);
          } catch {
            linked = false;
          }
        }
        if (!linked) {
          return res.status(403).json({
            error: 'NotMintingRole',
            message:
              'This token has not been minted yet, so the uploader must be an account that can mint ' +
              'it — the platform, or a hospital currently linked to this patient.',
          });
        }
        minterFacility = recovered.signer.toLowerCase();
      }
    }

    const { stored } = await putBlob(digest, payload);
    await putSealedKey(digest, sealKey(contentKey));

    if (isDbReady()) {
      await RecordModel.findOneAndUpdate(
        { tokenId: Number(tokenId) },
        {
          tokenId: Number(tokenId),
          patient: ethers.getAddress(patient).toLowerCase(),
          recordType: recordType || 'UNSPECIFIED',
          recordHash: digest,
          plainHash: String(plainHash || '').toLowerCase(),
          cid: cid || '',
          sealedKey: '(on disk)',
          fileName: fileName || 'record.bin',
          mimeType: mimeType || 'application/octet-stream',
          sizeBytes: payload.length,
          facility: minterFacility || '',
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
      verified:
        'The uploader\'s signature was checked, and either the token\'s on-chain owner signed or ' +
        'a minting account signed, with the bytes hashing to the on-chain digest.',
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
