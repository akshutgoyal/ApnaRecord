// THE UNLOCKED SESSION.
//
// Where the key lives between "the user typed their recovery code" and "the user
// closed the tab". Kept deliberately small and deliberately forgetful.
//
// WHAT IT STORES, AND WHY IT IS NO LONGER PLAINTEXT.
//
// It used to write `{address, privateKey}` straight into sessionStorage. Anything that
// could read storage — an XSS, a malicious extension, a shared machine with devtools —
// got a working private key, with no code to crack and nothing to notice.
//
// Now the key is wrapped with an AES-GCM key that is generated in the browser and
// marked NON-EXTRACTABLE, then kept in IndexedDB. The wrapped blob is what sits in
// sessionStorage. Storage scraping now yields ciphertext.
//
// WHAT THIS DOES NOT DO, stated plainly because the difference matters and it would be
// easy to read the paragraph above as more than it is: script running on this origin
// can still ask the browser to decrypt, because the browser will happily do that for
// any script on the page. This removes a passive leak, not an active attacker. The real
// fix is a signer the page cannot use without a user gesture — a passkey-backed device
// signer on a smart account — and `getLocalSigner()` remains the single place that
// would change when it arrives.
//
// WHY sessionStorage AND NOT localStorage. The session has to survive a refresh, or
// unlocking would mean re-typing a 20-character code every time anyone clicked a link —
// which in practice means the code ends up pasted into Notes and stops being a recovery
// secret. sessionStorage survives a refresh and dies with the tab.

import { JsonRpcProvider, Wallet } from 'ethers';

const DB_NAME = 'apnarecord-device';
const STORE_NAME = 'wrap-keys';
const DEVICE_KEY_ID = 'device-wrap';
const SESSION_KEY = 'apnarecord-session';

// Reads go to a public endpoint. Writes broadcast from the browser, so the provider
// sees them directly; relaying them through our own server is a later hardening step.
const RPC_URL =
  import.meta.env.VITE_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

let provider = null;
/** The unwrapped session, in memory. The only place a key exists in usable form. */
let cached = null;
let restoring = null;

function getProvider() {
  if (!provider) {
    provider = new JsonRpcProvider(RPC_URL);
  }
  return provider;
}

// ------------------------------------------------------------------ encoding

function toBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ------------------------------------------------------------- the device key

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idb(operation) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, operation.mode);
        const request = operation.run(tx.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

/**
 * The wrapping key for this browser profile.
 *
 * `extractable: false` is the point of the whole exercise — the key's bytes cannot be
 * read out by script even with full access to the page. It can only be *used*, which is
 * what makes the stored ciphertext worth less than the plaintext it replaced.
 *
 * Structured-cloning a CryptoKey into IndexedDB is supported everywhere this app runs.
 * Where it is not, the caller falls back to an in-memory-only session.
 */
async function getDeviceKey() {
  const existing = await idb({ mode: 'readonly', run: (store) => store.get(DEVICE_KEY_ID) });
  if (existing) return existing;

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await idb({ mode: 'readwrite', run: (store) => store.put(key, DEVICE_KEY_ID) });
  return key;
}

// -------------------------------------------------------------------- session

/**
 * Read the wrapped session back into memory. Awaited once during start-up, before
 * anything asks whether there is a session.
 */
export function restoreSession() {
  if (cached) return Promise.resolve(cached);
  if (restoring) return restoring;

  restoring = (async () => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed?.address || !parsed?.sealed || !parsed?.iv) return null;

      const key = await getDeviceKey();
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(parsed.iv) },
        key,
        fromBase64(parsed.sealed)
      );

      cached = { address: parsed.address, privateKey: new TextDecoder().decode(plain) };
      return cached;
    } catch {
      // A device key that no longer matches — a wiped profile, a restored backup, or a
      // blob from before this existed. Not an error worth surfacing: the recovery code
      // still opens the wallet, which is the whole design.
      return null;
    } finally {
      restoring = null;
    }
  })();

  return restoring;
}

/**
 * Hold an unlocked key for this tab.
 *
 * Cached synchronously so the rest of the app can read it immediately, then wrapped
 * for storage. If wrapping fails — no IndexedDB, or private mode — the session still
 * works for this page load and simply will not survive a refresh, which is a better
 * outcome than refusing to sign in.
 */
export async function saveSession({ address, privateKey }) {
  cached = { address, privateKey };

  try {
    const key = await getDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(privateKey)
    );
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ address, iv: toBase64(iv), sealed: toBase64(sealed) })
    );
  } catch {
    /* in-memory only for this page load */
  }
}

/** Drop the session. The device key is deliberately kept — it is per-device, not per-user. */
export function clearSession() {
  cached = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function readSession() {
  return cached;
}

export function sessionAddress() {
  return cached?.address || null;
}

export function hasSession() {
  return Boolean(cached);
}

/**
 * The local signer, or null when there is no unlocked session. This is the one
 * function the rest of the app needs to know about — and the one a device signer
 * would replace.
 */
export function getLocalSigner() {
  if (!cached) return null;
  return new Wallet(cached.privateKey, getProvider());
}

/** A read-only provider for chain calls, with no wallet involved. */
export function getLocalProvider() {
  return provider || getProvider();
}
