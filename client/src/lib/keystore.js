// THE KEYSTORE.
//
// A user never sees a wallet. This module creates one, locks the private key
// behind a recovery code the user writes on paper, and hands the server nothing
// but ciphertext.
//
// The server can verify who you are without ever being able to be you. That is
// the entire security claim of the product, and it rests on one rule enforced
// here: the recovery code is never sent anywhere, and the private key is only
// ever unwrapped in the browser.
//
// A note on the KDF. scrypt or Argon2id would be the better primitive, but
// `crypto.subtle` exposes neither — a browser-native implementation would mean
// shipping a JS scrypt, which is slower and easier to get wrong. So this is
// PBKDF2-SHA256 at 600k iterations, OWASP's current recommendation for that
// algorithm. The recovery code carries 100 bits of entropy, which is what
// actually makes offline guessing hopeless.

import { Wallet, randomBytes, hexlify, isHexString } from 'ethers';

// Crockford base32: no I, L, O or U, so the characters a person misreads are
// the ones already excluded. 20 characters at 5 bits each is 100 bits.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 20;
const GROUP_SIZE = 5;

export const KDF = Object.freeze({
  name: 'PBKDF2-SHA256',
  iterations: 600_000,
  hash: 'SHA-256',
  saltBytes: 16,
});

// ------------------------------------------------------------------ encoding

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ------------------------------------------------------------------- the code

/** A fresh recovery code, grouped for transcription onto paper. */
export function generateRecoveryCode() {
  const entropy = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const byte of entropy) {
    // Rejection sampling, so every character is equally likely. A plain modulo
    // would bias the first few letters, which silently costs entropy.
    let value = byte;
    while (value >= 256 - (256 % ALPHABET.length)) {
      value = crypto.getRandomValues(new Uint8Array(1))[0];
    }
    code += ALPHABET[value % ALPHABET.length];
  }
  return groupCode(code);
}

/** Insert the display dashes. */
function groupCode(code) {
  return (code.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g')) || []).join('-');
}

/**
 * Accept whatever a human typed and return the canonical code.
 *
 * People read 0 as O and 1 as l, so those substitutions are folded rather than
 * rejected. Anything genuinely outside the alphabet is rejected loudly — a
 * silently "corrected" code would fail to unwrap with a confusing error later.
 */
export function normaliseRecoveryCode(input) {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

  if (cleaned.length !== CODE_LENGTH) {
    throw new Error(
      `A recovery code is ${CODE_LENGTH} characters. That one is ${cleaned.length}.`
    );
  }
  for (const character of cleaned) {
    if (!ALPHABET.includes(character)) {
      throw new Error(`"${character}" is not a valid character in a recovery code.`);
    }
  }
  return cleaned;
}

export function looksLikeRecoveryCode(input) {
  try {
    normaliseRecoveryCode(input);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the wallet

/**
 * A fresh wallet. Deliberately not `Wallet.createRandom()`, which also builds a
 * BIP-39 mnemonic we have no use for — a second copy of the secret that would
 * exist only to be accidentally logged.
 */
export function createWallet() {
  const privateKey = hexlify(randomBytes(32));
  return { address: new Wallet(privateKey).address, privateKey };
}

// ---------------------------------------------------------------- wrap/unwrap

async function deriveWrappingKey(code, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normaliseRecoveryCode(code)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF.iterations, hash: KDF.hash },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Lock a private key behind a recovery code.
 *
 * Returns the sealed blob plus the salt and KDF parameters needed to reopen it.
 * The salt is not secret — it only has to be unique per keystore.
 */
export async function sealPrivateKey(privateKey, code) {
  if (!isHexString(privateKey, 32)) throw new Error('Not a 32-byte private key.');
  const salt = crypto.getRandomValues(new Uint8Array(KDF.saltBytes));
  const key = await deriveWrappingKey(code, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(privateKey)
  );

  const sealed = new Uint8Array(iv.length + cipher.byteLength);
  sealed.set(iv, 0);
  sealed.set(new Uint8Array(cipher), iv.length);

  return { sealed: toBase64(sealed), salt: toBase64(salt), iterations: KDF.iterations };
}

/**
 * Reopen a sealed key. Throws with a plain-language message on a wrong code —
 * GCM cannot tell you *why* it failed, so the wording has to carry the meaning.
 */
export async function openPrivateKey({ sealed, salt }, code) {
  let normalised;
  try {
    normalised = normaliseRecoveryCode(code);
  } catch (error) {
    throw new Error(error.message);
  }

  const combined = fromBase64(sealed);
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const key = await deriveWrappingKey(normalised, fromBase64(salt));

  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error(
      'That recovery code does not open this wallet. Check for a mistyped character — ' +
        'the code is case-insensitive and 0/O and 1/I/L are treated as the same.'
    );
  }
}
