// The server's only door to the blockchain. Read-only, by construction:
// there is no Wallet and no private key anywhere in this file.

import { ethers } from 'ethers';
import { ABI } from '../contractAbi.js';

let provider = null;
let iface = null;

export function getProvider() {
  if (!provider) {
    const url = process.env.SEPOLIA_RPC_URL;
    if (!url) throw new Error('SEPOLIA_RPC_URL is not set — see server/.env.example');
    // staticNetwork avoids a chainId round-trip on every single call.
    provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
  }
  return provider;
}

export function getAddress() {
  const address = process.env.CONTRACT_ADDRESS;
  if (!address) throw new Error('CONTRACT_ADDRESS is not set — see server/.env.example');
  return ethers.getAddress(address);
}

export function getInterface() {
  if (!iface) iface = new ethers.Interface(ABI);
  return iface;
}

/**
 * Execute a `view` function AS a specific address, and return the decoded result.
 *
 * This is the whole trust model in one function. `from` is what the contract sees
 * as msg.sender, so the contract runs its real permission checks against that
 * address. We never re-implement a rule here — we ask the contract.
 */
export async function callAs(functionName, args, from) {
  const i = getInterface();
  // Fail loudly on a missing ABI entry. Swallowing this is how a record once
  // looked "burned" when the real problem was an ABI that lacked `locked`.
  if (!i.getFunction(functionName)) {
    throw new Error(
      `Contract ABI has no function "${functionName}". Add it to server/src/contractAbi.js.`
    );
  }
  const data = i.encodeFunctionData(functionName, args);
  const result = await getProvider().call({
    to: getAddress(),
    data,
    ...(from ? { from: ethers.getAddress(from) } : {}),
  });
  return i.decodeFunctionResult(functionName, result);
}

/** Execute a `view` function from a neutral address (no permissions). */
export async function call(functionName, args = []) {
  return callAs(functionName, args);
}

/**
 * Make chain values JSON-safe. Decoded logs contain BigInt for every uint256 and
 * bytes32 (token ids, roles, timestamps), and JSON.stringify refuses BigInt —
 * which surfaces as a confusing "Do not know how to serialize a BigInt" on an
 * endpoint that otherwise looks fine.
 */
export function plain(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^\d+$/.test(key)) continue; // ethers Results also expose numeric keys
      out[key] = plain(entry);
    }
    return out;
  }
  return value;
}

/**
 * Turn any ethers throw into `{ name, args }` for a custom error, or null.
 * A revert is only useful if it can be named, so we look in every place ethers
 * and the RPC layer are known to hide the revert data.
 */
export function decodeRevert(error) {
  const i = getInterface();
  const candidates = [
    error?.data,
    error?.revert?.data,
    error?.info?.error?.data,
    error?.info?.error?.error?.data,
    error?.error?.data,
    error?.error?.error?.data,
    error?.value,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.startsWith('0x')) continue;
    try {
      const parsed = i.parseError(candidate);
      if (parsed) return { name: parsed.name, args: parsed.args };
    } catch {
      /* not one of ours */
    }
  }
  // Some nodes only give back a reason string.
  const reason = error?.reason || error?.shortMessage;
  if (typeof reason === 'string') {
    for (const known of ['AccessDenied', 'Expired', 'RecordNotFound', 'NotAuthorized']) {
      if (reason.includes(known)) return { name: known, args: [] };
    }
  }
  return null;
}

// ---------------------------------------------------------------- reads

// Public RPC providers cap eth_getLogs to a block range (50k on the default
// endpoint), so logs are scanned in chunks. Two things keep this cheap:
//   1. the scan starts at the block the contract was deployed in, not block 0;
//   2. the whole log set is fetched once and cached briefly, then filtered in
//      memory. Callers like recordMeta ask per-token, and refetching the chain
//      for every token would be absurd when the total is a handful of events.
const CHUNK = 45_000;
const LOG_TTL_MS = 20_000;

let deployBlockCache = null;
let logCache = { at: 0, logs: [] };

export async function getDeployBlock() {
  if (deployBlockCache !== null) return deployBlockCache;

  // An explicit override skips ~24 RPC round-trips. Set it in .env once you know
  // the block the contract was created in (Etherscan shows it on the creation tx).
  const override = Number(process.env.CONTRACT_DEPLOY_BLOCK);
  if (Number.isInteger(override) && override > 0) {
    deployBlockCache = override;
    return override;
  }

  const provider = getProvider();
  const address = getAddress();
  let low = 0;
  let high = await provider.getBlockNumber();

  if ((await provider.getCode(address, high)) === '0x') {
    throw new Error(
      `No contract code at ${address}. Check CONTRACT_ADDRESS and SEPOLIA_RPC_URL.`
    );
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(address, mid);
    if (code === '0x') low = mid + 1;
    else high = mid;
  }
  deployBlockCache = low;
  return low;
}

/** Every log for this contract, oldest first. Cached briefly. */
export async function getAllLogs({ force = false } = {}) {
  if (!force && Date.now() - logCache.at < LOG_TTL_MS) return logCache.logs;

  const provider = getProvider();
  const address = getAddress();
  const from = await getDeployBlock();
  const latest = await provider.getBlockNumber();
  const logs = [];
  for (let start = from; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest);
    logs.push(...(await provider.getLogs({ address, fromBlock: start, toBlock: end })));
  }
  logCache = { at: Date.now(), logs };
  return logs;
}

/** Logs filtered by topic0 (and optionally further indexed topics). */
export async function getLogsChunked(topics) {
  const all = await getAllLogs();
  if (!topics) return all;
  return all.filter((log) =>
    topics.every((wanted, index) => {
      if (!wanted) return true;
      const actual = log.topics[index];
      return typeof actual === 'string' && actual.toLowerCase() === String(wanted).toLowerCase();
    })
  );
}

export async function status() {
  const provider = getProvider();
  const network = await provider.getNetwork();
  const nextTokenId = (await call('nextTokenId'))[0];
  return {
    contract: getAddress(),
    chainId: Number(network.chainId),
    blockNumber: await provider.getBlockNumber(),
    nextTokenId: Number(nextTokenId),
  };
}

/** Every identity ever registered, rebuilt from the IdentityCreated log. */
export async function identities() {
  const logs = await getLogsChunked([ethers.id('IdentityCreated(address,string)')]);
  const i = getInterface();
  const seen = new Map();
  for (const log of logs) {
    const parsed = i.parseLog(log);
    if (!parsed) continue;
    const account = parsed.args[0];
    seen.set(account.toLowerCase(), {
      account,
      label: parsed.args[1],
      registeredAtBlock: log.blockNumber,
      txHash: log.transactionHash,
    });
  }
  // Deactivations and roles live in current state, not in the creation log.
  const managerRole = (await call('MANAGER_ROLE'))[0];
  const auditorRole = (await call('AUDITOR_ROLE'))[0];
  const adminRole = (await call('DEFAULT_ADMIN_ROLE'))[0];

  const out = await Promise.all(
    [...seen.values()].map(async (identity) => {
      const [identityRecord, manager, auditor, admin] = await Promise.all([
        call('identities', [identity.account]),
        call('hasRole', [managerRole, identity.account]),
        call('hasRole', [auditorRole, identity.account]),
        call('hasRole', [adminRole, identity.account]),
      ]);
      return {
        ...identity,
        active: identityRecord[2],
        onChainLabel: identityRecord[0],
        roles: {
          admin: admin[0],
          manager: manager[0],
          auditor: auditor[0],
        },
      };
    })
  );
  return out.sort((a, b) => a.registeredAtBlock - b.registeredAtBlock);
}

/** The authoritative answer to "what may this wallet do?" */
export async function permissions(address) {
  const managerRole = (await call('MANAGER_ROLE'))[0];
  const auditorRole = (await call('AUDITOR_ROLE'))[0];
  const adminRole = (await call('DEFAULT_ADMIN_ROLE'))[0];
  const [identityRecord, manager, auditor, admin, did] = await Promise.all([
    call('identities', [address]),
    call('hasRole', [managerRole, address]),
    call('hasRole', [auditorRole, address]),
    call('hasRole', [adminRole, address]),
    call('didFor', [address]),
  ]);
  return {
    address,
    did: did[0],
    identity: {
      label: identityRecord[0],
      createdAt: Number(identityRecord[1]),
      active: identityRecord[2],
    },
    roles: {
      admin: admin[0],
      manager: manager[0],
      auditor: auditor[0],
    },
  };
}

/**
 * Record metadata assembled from chain state alone, so it works with the
 * database switched off entirely. Token -> RecordMinted log -> owner.
 */
export async function recordMeta(tokenId) {
  const logs = await getLogsChunked([
    ethers.id('RecordMinted(uint256,address,bytes32,string)'),
    ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32),
  ]);
  if (logs.length === 0) return null;
  const i = getInterface();
  const parsed = i.parseLog(logs[0]);

  // A revoked record has its log but no owner, so `ownerOf` reverts with
  // ERC721NonexistentToken. Treat ONLY that as burned — any other failure is a
  // real problem and must surface rather than being reported as a burn.
  let patient = null;
  try {
    const [owner] = await call('ownerOf', [tokenId]);
    patient = owner;
  } catch (error) {
    const decoded = decodeRevert(error);
    const isBurn =
      decoded && (decoded.name === 'ERC721NonexistentToken' || decoded.name === 'RecordNotFound');
    if (!isBurn) throw error;
  }

  let locked = false;
  try {
    const [isLocked] = await call('locked', [tokenId]);
    locked = isLocked;
  } catch {
    /* burned tokens have no locked() answer; not worth failing the read */
  }

  return {
    tokenId: Number(tokenId),
    patient,
    recordHash: parsed.args[2],
    recordType: parsed.args[3],
    mintedAtBlock: logs[0].blockNumber,
    mintedTx: logs[0].transactionHash,
    locked,
    burned: patient === null,
  };
}

/** All tokens currently owned by an address (bounded scan — demo scale). */
export async function tokensOf(address) {
  const nextTokenId = Number((await call('nextTokenId'))[0]);
  const results = [];
  for (let tokenId = 1; tokenId < nextTokenId; tokenId++) {
    try {
      const [owner] = await call('ownerOf', [tokenId]);
      if (owner.toLowerCase() === address.toLowerCase()) {
        const meta = await recordMeta(tokenId);
        const [expiry] = await call('consent', [tokenId, address]);
        if (meta) results.push({ ...meta, ownerConsentExpiry: Number(expiry) });
      }
    } catch {
      // burned token — skip it
    }
  }
  return results;
}

/**
 * The free public primitive: does this digest match the record's on-chain digest?
 * Returns a verdict, never the record.
 */
export async function verifyRecord(tokenId, fileHash) {
  return call('verifyRecord', [tokenId, fileHash]);
}

/**
 * Block number -> ISO timestamp, cached per process.
 * Logs carry block numbers; humans need dates. Going from one to the other costs
 * an RPC call per block, so never repeat one.
 */
const blockTimeCache = new Map();

export async function blockTimestamps(blockNumbers) {
  const provider = getProvider();
  const out = {};
  for (const blockNumber of [...new Set(blockNumbers)]) {
    if (blockTimeCache.has(blockNumber)) {
      out[blockNumber] = blockTimeCache.get(blockNumber);
      continue;
    }
    try {
      const block = await provider.getBlock(blockNumber);
      const iso = block ? new Date(Number(block.timestamp) * 1000).toISOString() : null;
      blockTimeCache.set(blockNumber, iso);
      out[blockNumber] = iso;
    } catch {
      out[blockNumber] = null;
    }
  }
  return out;
}

/** Address -> registered label, from the identity log. */
export async function labelMap() {
  const list = await identities();
  const map = {};
  for (const entry of list) map[entry.account.toLowerCase()] = entry.label;
  return map;
}

/**
 * Transaction hash -> the address that SENT it.
 *
 * Some events do not name their actor. `RecordMinted` records the patient the
 * record was allocated to, not the admin who minted it, so reading the event
 * alone makes it look as though the patient created their own record. The sender
 * is the only place that fact lives.
 */
export async function transactionSenders(txHashes) {
  const provider = getProvider();
  const out = {};
  for (const hash of [...new Set(txHashes)]) {
    try {
      const tx = await provider.getTransaction(hash);
      out[hash] = tx?.from || null;
    } catch {
      out[hash] = null;
    }
  }
  return out;
}

/** The audit trail: every event of interest, newest first. */
export async function events(limit = 100) {
  const i = getInterface();
  const names = [
    'IdentityCreated',
    'IdentityDeactivated',
    'RecordRequested',
    'RecordMinted',
    'RecordRevoked',
    'AccessGranted',
    'AccessRevoked',
    'EmergencyAccessUsed',
  ];
  const logs = await getLogsChunked();
  const out = [];
  for (const log of logs) {
    // ethers v6 returns null from parseLog when the log is not one of ours.
    let parsed;
    try {
      parsed = i.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (!names.includes(parsed.name)) continue;
    out.push({
      name: parsed.name,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      // The real position of this log within its block. Needed as part of the
      // cache key: two events of the same name in one transaction are otherwise
      // indistinguishable and one would be silently overwritten.
      logIndex: log.index,
      args: plain(parsed.args.toObject()),
    });
  }
  return out.reverse().slice(0, limit);
}
