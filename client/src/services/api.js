// The browser's only door to the backend. Every page imports from here, so the
// API surface lives in exactly one file.

// Extension included so this module (and everything that imports it) can be loaded
// by plain Node, which the test suite does in order to assert that the wire formats
// below match the server's exactly. Vite resolves it either way.
import { API_URL } from '../contract.js';
import { getAddress, hexlify, randomBytes } from 'ethers';
import { READ_DOMAIN, READ_TYPES } from '../lib/readProof.js';


/**
 * PROVING WHO IS ASKING, WITHOUT ASKING EVERY TIME.
 *
 * The server stopped serving off-chain rows to anonymous callers. There is no session
 * cookie to carry an identity here, so the proof is the same EIP-712 statement the
 * record release uses, with tokenId 0 meaning "not about a particular record".
 *
 * That proof is single-use — its nonce is spent against a unique index, which is the
 * replay guard and is correct. Which means it cannot be the thing every read carries:
 * a page that reads four lists would ask the wallet to sign four times on every load,
 * and a prompt people learn to dismiss is not a control.
 *
 * So one signature buys a token, the token is reused until it expires, and it lives in
 * sessionStorage — surviving a refresh, dying with the tab, and carrying no capability
 * beyond reading. Every write is still signed per call, and entitlement is still decided
 * against the chain on the server for each request.
 *
 * The signer is REGISTERED rather than passed, because passing it would mean threading a
 * wallet through every call site that reads a list. ChainProvider calls setProofSigner
 * once, on connect.
 */
const TOKEN_KEY = 'apnarecord-read-token';

let proofSigner = null;
let inFlight = null;

export function setProofSigner(fn) {
  proofSigner = typeof fn === 'function' ? fn : null;
}

const store = () => (typeof sessionStorage !== 'undefined' ? sessionStorage : null);

function readToken() {
  try {
    const raw = store()?.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeToken(value) {
  try {
    if (value) store()?.setItem(TOKEN_KEY, JSON.stringify(value));
    else store()?.removeItem(TOKEN_KEY);
  } catch {
    /* a private-mode browser with no storage still works: it just signs more often */
  }
}

/** Drop the cached token. Called on connect, so a new wallet never inherits an old one. */
export function clearReadToken() {
  writeToken(null);
}

async function freshToken(signer, address) {
  const issuedAt = Date.now();
  const nonce = hexlify(randomBytes(32));
  const signature = await signer.signTypedData(READ_DOMAIN, READ_TYPES, {
    tokenId: 0,
    viewer: address,
    issuedAt,
    nonce,
  });

  const response = await fetch(`${API_URL}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewer: address, issuedAt, nonce, signature }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || 'Could not establish a read session.');
    error.code = payload.error || 'SESSION_FAILED';
    error.status = response.status;
    throw error;
  }

  const value = { address, token: payload.token, expiresAt: Date.parse(payload.expiresAt) };
  writeToken(value);
  return value;
}

async function authHeaders() {
  if (!proofSigner) return {};
  try {
    const signer = await proofSigner();
    if (!signer) return {};

    const address = getAddress(await signer.getAddress());
    const cached = readToken();
    if (cached && cached.address === address && cached.expiresAt - 30_000 > Date.now()) {
      return { Authorization: `Bearer ${cached.token}` };
    }
    clearReadToken();

    // One exchange at a time. Four lists loading together must not produce four prompts.
    if (!inFlight) {
      inFlight = freshToken(signer, address).finally(() => {
        inFlight = null;
      });
    }
    const minted = await inFlight;
    return { Authorization: `Bearer ${minted.token}` };
  } catch {
    // No proof available. The request goes unsigned, and the endpoints that need one will
    // say so in a sentence rather than a bare 401.
    return {};
  }
}

async function request(path, options = {}) {
  // Headers are merged, not replaced. Spreading `options` wholesale meant that
  // passing any custom header silently dropped the default Content-Type — harmless
  // for a GET, but it turns a signed POST into a body the server cannot parse, and
  // the failure looks like a bad signature rather than a missing content type.
  const { headers, proof, ...rest } = options;

  // `proof: true` asks for the wallet's token up front. The gates that serve a public
  // subset still answer 200 without one, so a retry-on-401 never fires for them — and a
  // signed-in dashboard would quietly get the redacted payload with every name blank.
  // The refusal retry below stays as the net for the gates that hard-require a proof.
  const upfront = proof ? await authHeaders() : {};

  const send = (extra = {}) =>
    fetch(`${API_URL}${path}`, {
      ...rest,
      headers: { 'Content-Type': 'application/json', ...(headers || {}), ...upfront, ...extra },
    });

  let response;
  try {
    response = await send();
  } catch {
    const error = new Error('Could not reach the API. Is the backend running on ' + API_URL + '?');
    error.code = 'API_DOWN';
    throw error;
  }

  // A gated read answers 401 ProofRequired. Prove the wallet once, then send the same
  // request again.
  //
  // Answering here rather than marking every call site matters for two reasons: the
  // public reads must never prompt (the verify page has no wallet at all), and a call
  // site that forgets to opt in would fail with a sentence about proving a wallet,
  // which reads like a permissions bug rather than a missing header.
  if (response.status === 401 && !('Authorization' in (headers || {}))) {
    const refusal = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (refusal.error === 'ProofRequired') {
      const proven = await authHeaders();
      if (Object.keys(proven).length) response = await send(proven);
    }
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Request failed (${response.status})`);
    error.code = payload.error || 'REQUEST_FAILED';
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

// ---------------------------------------------------------------- chain reads

export const chainStatus = () => request('/chain/status');

// ------------------------------------------------------------- wallet creation
//
// The key is generated and sealed in this browser, so what travels here is
// ciphertext the server cannot open. There is no call that lets it act as a user,
// and there must never be one.

// --- identity: proving you can receive at an address ---

export const requestEmailCode = (email) =>
  request('/identity/email/request', { method: 'POST', body: JSON.stringify({ email }) });

/** Returns a single-use grant. It can locate a wallet; it cannot open one. */
export const verifyEmailCode = (email, code) =>
  request('/identity/email/verify', { method: 'POST', body: JSON.stringify({ email, code }) });

/** Every wallet bound to the address behind this grant. */
export const lookupWallets = (grantToken) =>
  request('/wallet/lookup', { method: 'POST', body: JSON.stringify({ grantToken }) });

export const enrolWallet = (payload) =>
  request('/wallet/enrol', { method: 'POST', body: JSON.stringify(payload) });

/**
 * The sealed blob for one address, when the user knows their address but not which
 * email is bound. The email lookup is the recommended path.
 */
export const getWalletBlob = (address) => request(`/wallet/${address}`);

export const requestDrip = (address, payload) =>
  request(`/wallet/${address}/drip`, { method: 'POST', body: JSON.stringify(payload) });

/**
 * Replace the recovery code that wraps this wallet's key.
 *
 * Changes nothing on chain: same key, same account, same records. It only swaps the
 * code that opens the local copy, so the previous code stops working. The payload is
 * signed by the account's own key, so this is reachable only from an unlocked session.
 */
export const rotateRecovery = (address, payload) =>
  request(`/wallet/${address}/rotate-recovery`, { method: 'POST', body: JSON.stringify(payload) });

export const chainIdentities = () => request('/chain/identities', { proof: true });
export const chainPermissions = (address) =>
  request(`/chain/permissions/${address}`, { proof: true });

/**
 * The event log, filtered server-side.
 *
 * The log is the one dataset that grows without bound, so paging and filtering
 * happen on the server — pulling every event to filter for one is a habit that
 * eventually pulls every event.
 */
export const chainEvents = ({
  limit = 100,
  offset = 0,
  name,
  actor,
  search,
  fromBlock,
  toBlock,
  facility,
} = {}) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (name) params.set('name', name);
  if (actor) params.set('actor', actor);
  if (search) params.set('search', search);
  if (fromBlock) params.set('fromBlock', String(fromBlock));
  if (toBlock) params.set('toBlock', String(toBlock));
  if (facility) params.set('facility', String(facility));
  return request(`/chain/events?${params.toString()}`);
};

/** Everything that ever happened to one record, oldest first. */
export const recordHistory = (tokenId) =>
  request(`/chain/records/${tokenId}/history`, { proof: true });

// -------------------------------------------------------------- record index

export const listRecords = ({ facility } = {}) =>
  request(facility ? `/records?facility=${facility}` : '/records', { proof: true });
export const getRecord = (tokenId) => request(`/records/${tokenId}`, { proof: true });
export const recordsByOwner = (address) => request(`/records/owner/${address}`, { proof: true });

/** Store a record the browser already encrypted. */
export const storeRecord = (body) =>
  request('/records', { method: 'POST', body: JSON.stringify(body) });

/**
 * The consent-gated release. A 403 here is not an error to apologise for — it is
 * the contract refusing, and the code tells you which rule it applied.
 *
 * `proof` is the signed statement from lib/readProof.js. It is required: naming a
 * viewer is no longer enough, because consented addresses are public on-chain and
 * naming one used to be the whole of the attack.
 */
export const releaseFile = (tokenId, viewer, proof = {}) =>
  request(`/records/${tokenId}/file?viewer=${viewer}`, { headers: proof });

// ---------------------------------------------------------- dashboard data

/**
 * Aggregates for the dashboards, assembled server-side from chain state.
 * `fresh` bypasses the server's 60-second cache when someone presses refresh —
 * a refresh should mean "read the chain again", not "re-read the cache".
 */
export const getStats = ({ fresh = false, facility } = {}) => {
  const params = new URLSearchParams();
  if (fresh) params.set('fresh', '1');
  if (facility) params.set('facility', String(facility));
  const query = params.toString();
  return request(`/stats${query ? `?${query}` : ''}`, { proof: true });
};

// ------------------------------------------------- directory (off-chain metadata)
//
// Labels, facility names and request contents live in the database, because the
// chain refused to carry them. Every write is signed by a wallet the chain
// authorises for the matching on-chain act.

export const recordIdentity = (body) =>
  request('/identities', { method: 'POST', body: JSON.stringify(body) });

export const recordFacility = (body) =>
  request('/facilities', { method: 'POST', body: JSON.stringify(body) });

export const recordRequest = (body) =>
  request('/requests', { method: 'POST', body: JSON.stringify(body) });

export const facilityDetail = (it) => request(`/facilities/${it}`, { proof: true });

export const patientLinks = (address) => request(`/patients/${address}/links`, { proof: true });

// ------------------------------------------------- patient-owned profiles
// Off-chain display data. The chain records that a wallet is a label and owns
// tokens; it never learns a name. Writes carry a wallet signature, because there
// is no session to authenticate with.

export const listProfiles = () => request('/profiles', { proof: true });
export const getProfile = (address) => request(`/profiles/${address}`, { proof: true });

export const saveProfile = (address, body) =>
  request(`/profiles/${address}`, { method: 'PUT', body: JSON.stringify(body) });

// The signature travels in headers, not the query string. A bearer credential in a
// URL is copied into access logs, browser history and `Referer` headers — places it
// has no business being.
export const eraseProfile = (address, timestamp, signature) =>
  request(`/profiles/${address}`, {
    method: 'DELETE',
    headers: {
      'x-apnarecord-timestamp': String(timestamp),
      'x-apnarecord-signature': signature,
    },
  });

// ------------------------------------------------------- audit and verify

export const auditRecord = (tokenId) => request(`/audit/${tokenId}`);

export const verifyDigest = (tokenId, fileHash) =>
  request('/verify', {
    method: 'POST',
    body: JSON.stringify({ tokenId, fileHash }),
  });

/**
 * Enrolments with no identity on chain, for the admin console.
 *
 * It lists masked email addresses, so it is gated -- but by the read token, like every
 * other gated read. It used to take a signature per call, which meant the admin console
 * raised a second MetaMask prompt on mount on top of the one the token costs.
 */
export const pendingRegistrations = () => request('/admin/pending', { proof: true });
