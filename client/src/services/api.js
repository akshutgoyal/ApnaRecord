// The browser's only door to the backend. Every page imports from here, so the
// API surface lives in exactly one file.

// Extension included so this module (and everything that imports it) can be loaded
// by plain Node, which the test suite does in order to assert that the wire formats
// below match the server's exactly. Vite resolves it either way.
import { API_URL } from '../contract.js';

async function request(path, options = {}) {
  // Headers are merged, not replaced. Spreading `options` wholesale meant that
  // passing any custom header silently dropped the default Content-Type — harmless
  // for a GET, but it turns a signed POST into a body the server cannot parse, and
  // the failure looks like a bad signature rather than a missing content type.
  const { headers, ...rest } = options;

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...rest,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    });
  } catch {
    const error = new Error('Could not reach the API. Is the backend running on ' + API_URL + '?');
    error.code = 'API_DOWN';
    throw error;
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

export const chainIdentities = () => request('/chain/identities');
export const chainPermissions = (address) => request(`/chain/permissions/${address}`);

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
export const recordHistory = (tokenId) => request(`/chain/records/${tokenId}/history`);

// -------------------------------------------------------------- record index

export const listRecords = ({ facility } = {}) =>
  request(facility ? `/records?facility=${facility}` : '/records');
export const getRecord = (tokenId) => request(`/records/${tokenId}`);
export const recordsByOwner = (address) => request(`/records/owner/${address}`);

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
  return request(`/stats${query ? `?${query}` : ''}`);
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

export const facilityDetail = (it) => request(`/facilities/${it}`);

export const patientLinks = (address) => request(`/patients/${address}/links`);

// ------------------------------------------------- patient-owned profiles
// Off-chain display data. The chain records that a wallet is a label and owns
// tokens; it never learns a name. Writes carry a wallet signature, because there
// is no session to authenticate with.

export const listProfiles = () => request('/profiles');
export const getProfile = (address) => request(`/profiles/${address}`);

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
