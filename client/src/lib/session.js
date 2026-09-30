// THE UNLOCKED SESSION.
//
// Where the key lives between "the user typed their recovery code" and "the user
// closed the tab". Kept deliberately small and deliberately forgetful.
//
// WHY sessionStorage AND NOT localStorage. The key has to survive a page refresh,
// or unlocking would mean re-typing a 20-character code every time anyone clicked
// a link — which in practice means the code ends up pasted into Notes and stops
// being a recovery secret. sessionStorage survives a refresh but dies with the
// tab, which is the closest thing to memory-only that still works.
//
// This is still the weakest point in the design, and it is worth being plain about
// it: anything that can run script on this origin can read the key while a session
// is open. That is the price of not having MetaMask's isolation. A passkey-signed
// smart account removes the stored key entirely, and it is the upgrade this file is
// shaped to accept — `getLocalSigner()` is the only place that would change.
//
// The recovered-style trade-off is documented rather than hidden: a "remember this
// device" toggle is a product decision we have deliberately not made yet.

import { JsonRpcProvider, Wallet } from 'ethers';

const SESSION_KEY = 'apnarecord-session';

// Reads go to a public endpoint when there is no extension. Writes broadcast from
// the browser, so the provider sees them directly; relaying them through our own
// server is the planned hardening step.
const RPC_URL =
  import.meta.env.VITE_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

let provider = null;
let cachedKey = null;

function getProvider() {
  if (!provider) {
    provider = new JsonRpcProvider(RPC_URL);
  }
  return provider;
}

export function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.address && parsed?.privateKey ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession({ address, privateKey }) {
  cachedKey = privateKey;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ address, privateKey }));
  } catch {
    /* private mode — the session still works for this page load via cachedKey */
  }
}

export function clearSession() {
  cachedKey = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function sessionAddress() {
  return readSession()?.address || null;
}

export function hasSession() {
  return Boolean(readSession());
}

/**
 * The local signer, or null when there is no unlocked session. This is the one
 * function the rest of the app needs to know about.
 */
export function getLocalSigner() {
  const session = readSession();
  if (!session) return null;
  return new Wallet(session.privateKey, getProvider());
}

/** A read-only provider for chain calls, with no wallet involved. */
export function getLocalProvider() {
  return provider || getProvider();
}
