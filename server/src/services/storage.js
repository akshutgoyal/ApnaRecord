// Blob storage for encrypted records, plus sealing of each record's content key.
//
// Two separate things live here, and keeping them separate is the point:
//
//   Blob store  — holds ciphertext. The server can never read what it stores,
//                 because it never has the plaintext content key on disk.
//   Key sealing — each record has its own random AES-256-GCM content key. That
//                 key arrives from the browser and is immediately sealed under
//                 a server master key before it touches disk.
//
// WHAT THIS IS, HONESTLY: the demo's key wrapping is handled here, by the
// backend. That is the documented position — the production path delegates the
// release of wrapped keys to a decentralised key-management network (Lit
// Protocol), so that no server ever holds a usable key. Saying otherwise would
// overstate the build.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(here, '..', '..', 'uploads');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

async function ensureDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

function masterKey() {
  const raw = process.env.MASTER_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'MASTER_KEY must be 64 hex characters. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(raw, 'hex');
}

/** Normalize a digest for use as a filename. */
function cleanDigest(digest) {
  const clean = String(digest).toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
  if (clean.length !== 64) throw new Error('digest must be a 32-byte hex string');
  return clean;
}

function blobPath(digest) {
  return path.join(UPLOAD_DIR, `${cleanDigest(digest)}.enc`);
}

// The sealed content key lives beside the blob rather than in the database, so
// that the chain + this directory are enough to serve a record. MongoDB is then
// genuinely a cache: switch it off and nothing is lost.
function keyPath(digest) {
  return path.join(UPLOAD_DIR, `${cleanDigest(digest)}.key`);
}

// ------------------------------------------------------------- blob store

export async function putBlob(digest, buffer) {
  await ensureDir();
  const file = blobPath(digest);
  // Never overwrite: the digest IS the identity of the content. Same digest
  // means same bytes means the stored copy is already correct.
  try {
    await fs.access(file);
    return { stored: false, reason: 'already-present' };
  } catch {
    /* not there yet */
  }
  await fs.writeFile(file, buffer);
  return { stored: true };
}

export async function getBlob(digest) {
  return fs.readFile(blobPath(digest));
}

export async function hasBlob(digest) {
  try {
    await fs.access(blobPath(digest));
    return true;
  } catch {
    return false;
  }
}

export async function putSealedKey(digest, sealedBase64) {
  await ensureDir();
  await fs.writeFile(keyPath(digest), sealedBase64, 'utf8');
}

export async function getSealedKey(digest) {
  return fs.readFile(keyPath(digest), 'utf8');
}

// ------------------------------------------------------------ key sealing

/**
 * Seal a record's content key under the master key.
 * Layout: iv(12) | tag(16) | ciphertext — base64 encoded.
 */
export function sealKey(contentKeyHex) {
  const raw = Buffer.from(contentKeyHex, 'hex');
  if (raw.length !== 32) throw new Error('content key must be 32 bytes');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const sealed = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64');
}

/** Reverse of sealKey. Only called after the consent gate has passed. */
export function openKey(sealedBase64) {
  const buf = Buffer.from(sealedBase64, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('hex');
}

export const uploadDir = UPLOAD_DIR;
