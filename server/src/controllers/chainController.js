import { ethers } from 'ethers';
import {
  status,
  identities,
  permissions,
  events,
  recordMeta,
  verifyRecord,
  blockTimestamps,
  transactionSenders,
  labelMap,
} from '../services/chain.js';
import { entitledPatients } from '../middleware/requireWallet.js';

/** GET /api/chain/status — proves the read-only RPC path is live. */
export async function chainStatus(req, res) {
  try {
    const info = await status();
    return res.json({
      ok: true,
      ...info,
      // From the environment, not hardcoded. This one line was the reason a live
      // Base Sepolia deployment still handed out sepolia.etherscan.io links — a
      // correct transaction rendered as a dead explorer page, which reads as a
      // broken chain rather than a stale constant.
      explorer: `${process.env.EXPLORER_BASE || 'https://sepolia.basescan.org/address/'}${info.contract}`,
      note: 'Read-only. The server holds no signing key — every write is signed in the browser.',
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: 'ChainUnavailable', message: error.message });
  }
}

/** GET /api/chain/identities — rebuilt from IdentityCreated logs. */

export async function chainIdentities(req, res) {
  try {
    const list = await identities();
    const entitled = req.viewer
      ? await entitledPatients(req.viewer).catch(() => new Set())
      : new Set();
    return res.json({
      identities: list.map((entry) => ({
        ...entry,
        label:
          entitled === null || entitled.has(String(entry.account).toLowerCase())
            ? entry.label
            : null,
      })),
      source: 'IdentityCreated logs + hasRole',
    });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/**
 * GET /api/chain/permissions/:address
 * The single source of truth for "what is this wallet?". Both the role badge and
 * the page body read this, so they can never disagree with each other.
 */
export async function chainPermissions(req, res) {
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'BadRequest', message: 'Not a valid address.' });
  }
  try {
    const result = await permissions(address);
    const entitled = req.viewer
      ? await entitledPatients(req.viewer).catch(() => new Set())
      : new Set();
    if (entitled !== null && !entitled.has(address.toLowerCase())) {
      result.identity.label = null;
    }
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

// How far back a filtered query scans. The whole log set is fetched once and
// cached in-process by services/chain.js, so this is a cap on the in-memory
// filter, not on RPC cost — but it is still reported back so a caller can tell
// the difference between "no matches" and "no matches in the part I read".
const EVENT_SCAN_LIMIT = 1000;

/**
 * GET /api/chain/events
 *
 * Query: name, actor, search, fromBlock, toBlock, offset, limit
 *
 * Filtering happens server-side because the log is the one dataset that grows
 * without bound, and a client that has to pull every event to filter it will
 * eventually pull all of them to filter for one.
 */
export async function chainEvents(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const name = (req.query.name || '').trim();
    const actor = (req.query.actor || '').trim().toLowerCase();
    const search = (req.query.search || '').trim().toLowerCase();
    const fromBlock = Number(req.query.fromBlock) || null;
    const toBlock = Number(req.query.toBlock) || null;

    let matched = await events(EVENT_SCAN_LIMIT);

    if (name) matched = matched.filter((event) => event.name === name);
    if (actor) {
      matched = matched.filter((event) =>
        Object.values(event.args || {}).some(
          (value) => typeof value === 'string' && value.toLowerCase() === actor
        )
      );
    }
    if (search) {
      matched = matched.filter(
        (event) =>
          event.txHash.toLowerCase().includes(search) ||
          JSON.stringify(event.args || {}).toLowerCase().includes(search)
      );
    }
    if (fromBlock !== null) matched = matched.filter((event) => event.blockNumber >= fromBlock);
    if (toBlock !== null) matched = matched.filter((event) => event.blockNumber <= toBlock);

    const facility = (req.query.facility || '').trim();
    if (facility) {
      const { linkedPatientsOf } = await import('../lib/facilityScope.js');
      const { RecordModel, RequestModel, isDbReady } = await import('../models/index.js');
      let patients;
      try {
        patients = new Set((await linkedPatientsOf(facility)).map((p) => p.toLowerCase()));
      } catch (error) {
        return res
          .status(error.status || 500)
          .json({ error: error.error || 'ScopeFailed', message: error.message });
      }
      // Token and request anchors resolve to patients through the database —
      // the events themselves no longer name them.
      let tokenPatient = new Map();
      let requestPatient = new Map();
      if (isDbReady()) {
        try {
          const [recordRows, requestRows] = await Promise.all([
            RecordModel.find({ metadataConfirmed: true }).lean().catch(() => []),
            RequestModel.find().lean().catch(() => []),
          ]);
          tokenPatient = new Map(recordRows.map((r) => [String(r.tokenId), String(r.patient || '').toLowerCase()]));
          requestPatient = new Map(requestRows.map((r) => [String(r.requestId), String(r.patient || '').toLowerCase()]));
        } catch {
          /* unresolvable edges are dropped below */
        }
      }
      const inScope = (address) => address && patients.has(String(address).toLowerCase());
      matched = matched.filter((event) => {
        const args = event.args || {};
        if (args.tokenId !== undefined && inScope(tokenPatient.get(String(args.tokenId)))) return true;
        if (args.requestId !== undefined && inScope(requestPatient.get(String(args.requestId)))) return true;
        if (args.patient && inScope(args.patient)) return true;
        if (args.facility && String(args.facility).toLowerCase() === facility.toLowerCase()) return true;
        return Object.values(args).some(
          (value) => typeof value === 'string' && inScope(value) && value.toLowerCase() !== facility.toLowerCase()
        );
      });
    }

    const total = matched.length;
    const page = matched.slice(offset, offset + limit);

    // Timestamps cost one RPC call per distinct block, so they are resolved for
    // the page only — never for the whole matched set.
    const times = await blockTimestamps(page.map((event) => event.blockNumber));

    return res.json({
      events: page.map((event) => ({ ...event, timestamp: times[event.blockNumber] || null })),
      total,
      offset,
      limit,
      scanned: EVENT_SCAN_LIMIT,
      filters: {
        name: name || null,
        actor: actor || null,
        search: search || null,
        fromBlock,
        toBlock,
        facility: facility ? facility.toLowerCase() : null,
      },
    });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/**
 * GET /api/chain/records/:tokenId/history
 *
 * Everything that ever happened to one record, oldest first, each entry naming
 * its actor. This is what makes a drill-down possible: a record row in a table
 * can open into its own timeline instead of dumping the reader into a global log
 * and asking them to search.
 */
export async function chainRecordHistory(req, res) {
  const tokenId = Number(req.params.tokenId);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return res
      .status(400)
      .json({ error: 'BadRequest', message: 'tokenId must be a positive integer.' });
  }

  try {
    const record = await recordMeta(tokenId);
    if (!record) return res.status(404).json({ error: 'RecordNotFound', message: 'No such record.' });

    const entitled = req.viewer
      ? await entitledPatients(req.viewer).catch(() => new Set())
      : new Set();
    let maySeeOffChain =
      entitled === null ||
      Boolean(record.patient && entitled.has(String(record.patient).toLowerCase()));
    if (!maySeeOffChain && req.viewer) {
      maySeeOffChain = await call('canAccess', [tokenId, req.viewer])
        .then((result) => Boolean(result?.[0]))
        .catch(() => false);
    }

    const TOKEN_EVENTS = [
      'RecordRequested',
      'RecordMinted',
      'RecordRevoked',
      'AccessGranted',
      'AccessRevoked',
      'EmergencyAccessUsed',
      'Locked',
    ];

    const all = await events(EVENT_SCAN_LIMIT);

    // RecordRequested carries no tokenId and no patient — only (requestId,
    // requester). The contents live in the database, so requests for THIS
    // record's patient are resolved there and matched by requestId.
    let requestIdsForPatient = null;
    try {
      const { RequestModel, isDbReady } = await import('../models/index.js');
      if (isDbReady() && record.patient) {
        const rows = await RequestModel.find({ patient: String(record.patient).toLowerCase() }).lean();
        requestIdsForPatient = new Set(rows.map((r) => String(r.requestId)));
      }
    } catch {
      /* anchors cannot be attributed without the database */
    }

    const relevant = all.filter((event) => {
      if (!TOKEN_EVENTS.includes(event.name)) return false;
      const args = event.args || {};
      if (args.tokenId !== undefined) return String(args.tokenId) === String(tokenId);
      if (event.name === 'RecordRequested' && maySeeOffChain && requestIdsForPatient) {
        return requestIdsForPatient.has(String(args.requestId));
      }
      return false;
    });

    const [times, senders, labels] = await Promise.all([
      blockTimestamps(relevant.map((event) => event.blockNumber)),
      transactionSenders(relevant.map((event) => event.txHash)),
      labelMap(),
    ]);

    const timeline = relevant
      .map((event) => {
        const args = event.args || {};
        // Which field names the actor differs per event. RecordMinted is the odd
        // one out: it names the patient the token was allocated to, not the admin
        // who minted it, so the transaction sender is the only truthful source.
        let actor = args.viewer || args.requester || args.admin || args.patient || null;
        if (event.name === 'RecordMinted' && senders[event.txHash]) actor = senders[event.txHash];
        return {
          name: event.name,
          blockNumber: event.blockNumber,
          txHash: event.txHash,
          logIndex: event.logIndex,
          timestamp: times[event.blockNumber] || null,
          actor,
          actorLabel:
            maySeeOffChain && actor ? labels[String(actor).toLowerCase()] || null : null,
          args,
        };
      })
      .reverse(); // oldest first: a timeline reads forwards

    return res.json({
      tokenId,
      record: {
        tokenId: record.tokenId,
        patient: record.patient,
        ...(maySeeOffChain ? { recordType: record.recordType } : {}),
        recordHash: record.recordHash,
        mintedAtBlock: record.mintedAtBlock,
        mintedTx: record.mintedTx,
        locked: record.locked,
        burned: record.burned,
      },
      events: timeline,
      total: timeline.length,
    });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/**
 * GET /api/audit/:tokenId
 * Mirrors the contract's auditRecord: metadata only. The CID is not included,
 * because the contract never releases it to an auditor.
 */
export async function audit(req, res) {
  const tokenId = Number(req.params.tokenId);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return res.status(400).json({ error: 'BadRequest', message: 'tokenId must be a positive integer.' });
  }
  try {
    const record = await recordMeta(tokenId);
    if (!record) return res.status(404).json({ error: 'RecordNotFound', message: 'No such record.' });
    return res.json({
      tokenId: record.tokenId,
      recordHash: record.recordHash,
      patient: record.patient,
      mintedAtBlock: record.mintedAtBlock,
      mintedTx: record.mintedTx,
      locked: record.locked,
      // Deliberately absent: off-chain type, CID, file name, MIME type, and bytes.
      fileReleased: false,
      note: 'Metadata only. The contract does not release the file location to an auditor.',
    });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}

/**
 * POST /api/verify   { tokenId, fileHash }  OR  { tokenId, ciphertext }
 * Free and permissionless — no wallet, no consent, no account. Returns a verdict
 * and never the record.
 */
export async function verify(req, res) {
  const tokenId = Number(req.body?.tokenId);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return res.status(400).json({ error: 'BadRequest', message: 'tokenId must be a positive integer.' });
  }

  let provided = req.body?.fileHash;
  if (!provided && typeof req.body?.ciphertext === 'string') {
    // Hash it here so a client that only holds the file can still ask.
    provided = ethers.keccak256(Buffer.from(req.body.ciphertext, 'base64'));
  }
  if (typeof provided !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(provided)) {
    return res.status(400).json({
      error: 'BadRequest',
      message: 'Provide fileHash (0x + 64 hex chars) or ciphertext (base64).',
    });
  }

  try {
    const record = await recordMeta(tokenId);
    if (!record) return res.status(404).json({ error: 'RecordNotFound', message: 'No such record.' });

    const [verdict] = await verifyRecord(tokenId, provided);

    // The chain anchors keccak256 of the CIPHERTEXT, which is right for the stored blob
    // and useless to the person who registered the record -- they hold the scan, not the
    // ciphertext, and encryption takes a fresh IV each time, so they can never reproduce
    // it. Their own file answered "Tampered".
    //
    // So a second check against the plaintext digest recorded at mint. It is the weaker
    // claim, and the response names which one matched rather than letting the two be
    // confused: 'chain' means the contract agreed, 'server' means the platform's own record
    // did. Anyone who wants the strong claim sends the encrypted file.
    if (verdict) {
      return res.json({
        tokenId,
        provided,
        onChain: record.recordHash,
        authentic: true,
        verifiedBy: 'chain',
        // Deliberately not returned: the file, the CID, or anything readable.
      });
    }

    // `record` came off the chain and carries no plaintext digest -- that lives in the
    // record row. Reading it from `record` would have made this branch dead code, which is
    // exactly what the first test showed.
    const { RecordModel, isDbReady } = await import('../models/index.js');
    const row = isDbReady()
      ? await RecordModel.findOne({
          tokenId,
          recordHash: String(record.recordHash).toLowerCase(),
          mintedTx: String(record.mintedTx || '').toLowerCase(),
          patient: String(record.patient || '').toLowerCase(),
          metadataConfirmed: true,
        }).select('plainHash').lean()
      : null;

    const providedLower = String(provided).toLowerCase();
    if (row?.plainHash && String(row.plainHash).toLowerCase() === providedLower) {
      return res.json({
        tokenId,
        provided,
        onChain: record.recordHash,
        authentic: true,
        verifiedBy: 'server',
        note:
          "This is the plaintext digest the platform recorded when the record was minted. " +
          "That is the platform's word rather than the chain's -- the chain anchors the encrypted " +
          "file. Send the encrypted file for a check the contract performs itself.",
      });
    }

    return res.json({
      tokenId,
      provided,
      onChain: record.recordHash,
      hasPlaintextRecord: Boolean(row?.plainHash),
      authentic: false,
      verifiedBy: null,
      // Deliberately not returned: the file, the CID, or anything readable.
    });
  } catch (error) {
    return res.status(502).json({ error: 'ChainUnavailable', message: error.message });
  }
}
