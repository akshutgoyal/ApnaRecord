// Browser-side encryption. The record is sealed HERE, not on the server.
//
//   content key : 32 random bytes, generated in this tab, never derived
//   payload     : iv (12 bytes) || AES-256-GCM ciphertext || tag (16 bytes)
//   digest      : keccak256(payload) — the 32 bytes that go on-chain
//
// The server receives the ciphertext and the key. It cannot read the record from
// disk alone, and it seals the key under its own master key before writing
// anything down. WebCrypto appends the GCM tag to the ciphertext, which is
// exactly the layout the server's Node-side decrypt expects — hence no juggling.

import { keccak256 } from 'ethers';

const IV_BYTES = 12;
const KEY_BYTES = 32;

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const clean = hex.replace(/^0x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importKey(keyBytes) {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a file in the browser.
 * @returns {{ payload: Uint8Array, digest: string, contentKey: string, sizeBytes: number }}
 */
export async function encryptRecord(arrayBuffer) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(keyBytes);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer)
  );

  const payload = new Uint8Array(iv.length + ciphertext.length);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.length);

  return {
    payload,
    digest: keccak256(payload),
    contentKey: toHex(keyBytes),
    sizeBytes: payload.length,
  };
}

/**
 * Decrypt a record this app produced (or the server released).
 * Throws if the ciphertext or the key has been altered — GCM authenticates.
 */
export async function decryptRecord(payloadBytes, contentKeyHex) {
  const key = await importKey(fromHex(contentKeyHex));
  const iv = payloadBytes.subarray(0, IV_BYTES);
  const body = payloadBytes.subarray(IV_BYTES);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
  return new Uint8Array(plain);
}

export { toHex, fromHex, toBase64, fromBase64 };

/** keccak256 of raw bytes, as a 0x string. Used by the verify page. */
export function digestOf(arrayBuffer) {
  return keccak256(new Uint8Array(arrayBuffer));
}

/** Pretty byte count. */
export function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
