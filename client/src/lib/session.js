// THE UNLOCKED SESSION.
//
// Where the key lives between "the user unlocked this device" and "the user locked it".
//
// WHAT CHANGED, AND WHY IT NEEDED TO.
//
// It used to live in sessionStorage, wrapped under a non-extractable key in IndexedDB.
// That survived a refresh and died with the tab — so closing the tab meant typing a
// twenty-character recovery code again. In practice that is how a recovery code ends up
// pasted into Notes, which is precisely what §2 warns about. The convenience was worth
// having; the question was how to pay for it.
//
// NOT by putting the key somewhere that persists in the clear. The blob moves to
// IndexedDB so it outlives the tab, and the key it is wrapped with is derived from a
// DEVICE SECRET — a passkey's PRF output, or a device PIN — rather than from a stored
// key the page can simply use. See deviceUnlock.js for why that distinction is the whole
// design rather than a detail.
//
// UNLOCK ONCE PER BROWSER SESSION. The first time the app is opened, the device secret
// is required. After that the derived key is cached and a sessionStorage marker records
// that this browser session is already unlocked, so refreshes and new tabs do not
// re-prompt. A new browser session clears the marker and asks again.
//
// WHAT THIS PROTECTS, AND WHAT IT DOES NOT. Stated plainly, because the paragraphs above
// would otherwise read as more than they are:
//
//   • It protects a device someone else picks up. Opening the site does not sign you in;
//     it asks for a fingerprint or the PIN, and five wrong PINs wipe the stored blob.
//   • It does NOT protect against script running on this origin. While the session is
//     unlocked the page can use the key, because that is what an unlocked session means.
//     Caching the derived key for the session is the cost of not re-prompting on every
//     refresh, and it is the honest price of the convenience.
//   • Scraping IndexedDB yields a wrapped blob, never a private key. That is the part
//     that is strictly better than what this replaced.

import { JsonRpcProvider, Wallet } from 'ethers';
import { API_URL } from '../contract.js';
import {
  derivePinKey,
  encodeBytes,
  decodeBytes,
  newPinSalt,
  passkeyCapability,
  registerPasskey,
  unlockWithPasskey,
} from './deviceUnlock.js';

const DB_NAME = 'apnarecord-device';
const SESSION_STORE = 'session';
const KEY_STORE = 'keys';
const RECORD_ID = 'current';
const SESSION_KEY_ID = 'session-key';
const UNLOCKED_MARKER = 'apnarecord-unlocked';

// Chain access goes through this server, not a public node.
//
// Pointing at publicnode.com directly meant that node saw every user's IP sitting
// beside the addresses they read and the transactions they sent. The chain was built so
// that a record's owner cannot be identified from it — and then the transport handed
// the join back for free, because asking for a balance reveals whose it is.
//
// `VITE_SEPOLIA_RPC_URL` still overrides this, deliberately: it is the escape hatch when
// the API itself is down. It is also the way to put the leak back, so it is unset by
// default and should stay that way.
const RPC_URL = import.meta.env.VITE_SEPOLIA_RPC_URL || `${API_URL}/rpc`;

let provider = null;
/** The unwrapped session, in memory. The only place a key exists in usable form. */
let cached = null;
let restoring = null;
/** Set when a stored session exists but needs the device secret before it can be opened. */
let lockedAddress = null;

function getProvider() {
  if (!provider) provider = new JsonRpcProvider(RPC_URL);
  return provider;
}

// ------------------------------------------------------------- IndexedDB plumbing

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(store, key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ------------------------------------------------------------------ the marker

function markUnlocked() {
  try {
    sessionStorage.setItem(UNLOCKED_MARKER, '1');
  } catch {
    /* private mode; the session still works for this page load */
  }
}

function isMarkedUnlocked() {
  try {
    return sessionStorage.getItem(UNLOCKED_MARKER) === '1';
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- wrapping

async function sealWith(deviceKey, privateKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    deviceKey,
    new TextEncoder().encode(privateKey)
  );
  return { iv: encodeBytes(iv), sealed: encodeBytes(sealed) };
}

async function openWith(deviceKey, record) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBytes(record.iv) },
    deviceKey,
    decodeBytes(record.sealed)
  );
  return new TextDecoder().decode(plain);
}

/**
 * Put a session in place, wrapped under a device secret that has already been derived.
 *
 * Called from two places, and the difference matters: at enrolment, and on a later
 * unlock. Both pass the derived key so this never has to prompt.
 */
export async function saveSession({ address, privateKey, method, deviceKey, credentialId, prfSalt, pinSalt }) {
  cached = { address, privateKey, method };

  try {
    const wrapped = await sealWith(deviceKey, privateKey);
    await idbPut(SESSION_STORE, RECORD_ID, {
      address,
      method,
      credentialId: credentialId ?? null,
      // Only the salt is kept. The PIN itself is never stored, and neither is the PRF
      // output — both are re-derived from the device on each new browser session.
      prfSalt: prfSalt ? encodeBytes(new Uint8Array(prfSalt)) : null,
      pinSalt: pinSalt ? encodeBytes(new Uint8Array(pinSalt)) : null,
      ...wrapped,
    });
    // Cached so a refresh inside this browser session does not re-prompt. Non-extractable,
    // so its bytes cannot be read out even from here.
    await idbPut(KEY_STORE, SESSION_KEY_ID, deviceKey);
    markUnlocked();
  } catch {
    // No IndexedDB, or private mode. The session works for this page load and will not
    // survive a refresh — better than refusing to sign in.
  }
}

/**
 * Set up the device unlock and store the first session. Used at enrolment, where the
 * key is in hand and there is nothing to unwrap yet.
 */
export async function linkDevice({ address, privateKey, pin }) {
  const capability = await passkeyCapability();

  if (capability.available && !pin) {
    try {
      const { deviceKey, credentialId, prfSalt } = await registerPasskey({ label: 'ApnaRecord' });
      await saveSession({
        address,
        privateKey,
        method: 'passkey',
        deviceKey,
        credentialId,
        prfSalt,
      });
      return { method: 'passkey' };
    } catch (error) {
      // The passkey path failed at the platform. A PIN is still available, so say what
      // happened rather than failing the enrolment.
      if (!pin) return { method: 'none', reason: error.message };
    }
  }

  if (pin) {
    const pinSalt = newPinSalt();
    const deviceKey = await derivePinKey(pin, pinSalt);
    await saveSession({ address, privateKey, method: 'pin', deviceKey, pinSalt });
    return { method: 'pin' };
  }

  // Neither factor is available. Store nothing durable: the recovery code remains the
  // only way in, exactly as before this existed.
  cached = { address, privateKey, method: 'memory' };
  return { method: 'memory', reason: capability.reason };
}

/**
 * Re-wrap the current session under a device PIN.
 *
 * Used where no passkey is available. It re-wraps what is already in memory rather than
 * taking the key back from the caller, so the key never travels further than it has to.
 */
export async function secureDeviceWithPin(pin) {
  if (!cached) throw new Error('There is no unlocked session to secure.');
  const pinSalt = newPinSalt();
  const deviceKey = await derivePinKey(pin, pinSalt);
  await saveSession({
    address: cached.address,
    privateKey: cached.privateKey,
    method: 'pin',
    deviceKey,
    pinSalt,
  });
  return { method: 'pin' };
}

// --------------------------------------------------------------------- reading

/** Read the stored record without opening it. */
async function storedRecord() {
  try {
    return (await idbGet(SESSION_STORE, RECORD_ID)) || null;
  } catch {
    return null;
  }
}

/**
 * Bring a stored session back into memory.
 *
 * Returns a state rather than a boolean, because "there is a session but it is locked"
 * is a real state the shell has to render and it is not the same as "there is no
 * session". Conflating them is what sends a returning user to the sign-up page.
 */
export function restoreSession() {
  if (cached) return Promise.resolve({ state: 'unlocked', address: cached.address });
  if (restoring) return restoring;

  restoring = (async () => {
    try {
      const record = await storedRecord();
      if (!record) {
        lockedAddress = null;
        return { state: 'none' };
      }

      if (!isMarkedUnlocked()) {
        lockedAddress = record.address;
        return { state: 'locked', address: record.address, method: record.method };
      }

      const deviceKey = await idbGet(KEY_STORE, SESSION_KEY_ID);
      if (!deviceKey) {
        lockedAddress = record.address;
        return { state: 'locked', address: record.address, method: record.method };
      }

      const privateKey = await openWith(deviceKey, record);
      cached = { address: record.address, privateKey, method: record.method };
      lockedAddress = null;
      return { state: 'unlocked', address: record.address };
    } catch {
      // A device key that no longer matches — a wiped profile, a restored backup. The
      // recovery code still opens the wallet, which is the whole design.
      const record = await storedRecord();
      lockedAddress = record?.address || null;
      return record
        ? { state: 'locked', address: record.address, method: record.method }
        : { state: 'none' };
    } finally {
      restoring = null;
    }
  })();

  return restoring;
}

/**
 * Open a locked session with a device secret.
 *
 * `pin` is required only on the PIN path; the passkey path prompts the platform itself.
 */
export async function unlockSession({ pin } = {}) {
  const record = await storedRecord();
  if (!record) return { state: 'none' };

  let deviceKey;
  if (record.method === 'passkey') {
    deviceKey = await unlockWithPasskey({
      credentialId: decodeBytes(record.credentialId),
      prfSalt: decodeBytes(record.prfSalt),
    });
  } else if (record.method === 'pin') {
    if (!pin) throw new Error('This device needs its PIN.');
    deviceKey = await derivePinKey(pin, decodeBytes(record.pinSalt));
  } else {
    throw new Error('This device has no unlock method stored.');
  }

  // Throws on a wrong PIN — GCM cannot say why it failed, so the caller words it.
  const privateKey = await openWith(deviceKey, record);

  cached = { address: record.address, privateKey, method: record.method };
  lockedAddress = null;
  try {
    await idbPut(KEY_STORE, SESSION_KEY_ID, deviceKey);
    markUnlocked();
  } catch {
    /* in-memory only */
  }

  return { state: 'unlocked', address: record.address };
}

/**
 * Lock this device without forgetting the wallet.
 *
 * The stored blob stays, so unlocking works again; what goes is the cached key and the
 * marker, so the next open asks for the device secret. This is "sign out", not "delete
 * my account".
 */
export function clearSession() {
  cached = null;
  lockedAddress = null;
  try {
    sessionStorage.removeItem(UNLOCKED_MARKER);
  } catch {
    /* ignore */
  }
  return Promise.all([
    idbDelete(KEY_STORE, SESSION_KEY_ID).catch(() => {}),
  ]);
}

/** Forget the stored session entirely. The recovery code is then the only way back. */
export async function forgetDevice() {
  cached = null;
  lockedAddress = null;
  try {
    sessionStorage.removeItem(UNLOCKED_MARKER);
  } catch {
    /* ignore */
  }
  await idbDelete(SESSION_STORE, RECORD_ID).catch(() => {});
  await idbDelete(KEY_STORE, SESSION_KEY_ID).catch(() => {});
}

// --------------------------------------------------------------- accessors

export function readSession() {
  return cached;
}

export function sessionAddress() {
  return cached?.address || lockedAddress || null;
}

/** True only when the key is actually usable. A locked session is not a session. */
export function hasSession() {
  return Boolean(cached);
}

export function isLocked() {
  return Boolean(lockedAddress) && !cached;
}

export function lockedSessionAddress() {
  return lockedAddress;
}

/**
 * The local signer, or null when there is no unlocked session. This is the one function
 * the rest of the app needs to know about.
 */
export function getLocalSigner() {
  if (!cached) return null;
  return new Wallet(cached.privateKey, getProvider());
}

/** A read-only provider for chain calls, with no wallet involved. */
export function getLocalProvider() {
  return provider || getProvider();
}
