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
// that the chain + the blob store are enough to serve a record. MongoDB is then
// genuinely a cache: switch it off and nothing is lost.
function keyPath(digest) {
  return path.join(UPLOAD_DIR, `${cleanDigest(digest)}.key`);
}

// ------------------------------------------------------------- blob store
//
// Two backends, selected by configuration rather than by a flag.
//
//   R2 / S3     when S3_BUCKET is set. This is what a deployment must use, because a
//               filesystem does not survive a redeploy. The chain keeps its anchors, so
//               verification still says the file existed and was never altered — but
//               nobody can fetch it, and the record becomes a proof of a document that
//               exists nowhere. `render.yaml` has carried a note about this for a while.
//
//   filesystem  otherwise, and only locally. It is what keeps the suite running without
//               credentials, on the same reasoning as the email mock: the real path is
//               the default and the shortcut is impossible in production rather than
//               simply absent.
//
// Both stores use the SAME keys — `<digest>.enc` for the ciphertext, `<digest>.key` for
// the sealed content key — which is what makes the two interchangeable rather than merely
// similar. Neither can read what it holds: the ciphertext is sealed in the browser, and
// the content key is sealed under the master key before it is written anywhere.

// Read per call, not captured at import.
//
// As a module-level const this was fixed at load, so anything importing this file
// before dotenv ran saw an empty bucket — and silently fell back to local disk. The
// failure that produces is a read reporting "this server does not hold its bytes",
// which points at the deployment rather than at the import order that caused it.
const bucket = () => process.env.S3_BUCKET || '';
const objectStoreConfigured = () => Boolean(bucket());

let objectStoreClient = null;

async function objectStore() {
  if (!objectStoreClient) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    objectStoreClient = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return objectStoreClient;
}

/** Which backend is live. Surfaced so a deployment can be asked rather than assumed. */
export function storageBackend() {
  return objectStoreConfigured() ? 'r2' : 'filesystem';
}

export const blobKey = (digest) => `${cleanDigest(digest)}.enc`;
export const sealedKeyKey = (digest) => `${cleanDigest(digest)}.key`;

async function readFromObjectStore(key) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const found = await (await objectStore()).send(
    new GetObjectCommand({ Bucket: bucket(), Key: key })
  );
  return Buffer.from(await found.Body.transformToByteArray());
}

export async function putBlob(digest, buffer) {
  if (objectStoreConfigured()) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    // Never overwrite: the digest IS the identity of the content. The same
    // digest means the same bytes means the stored copy is already correct.
    try {
      await getBlob(digest);
      return { stored: false, reason: 'already-present' };
    } catch {
      /* not there yet */
    }
    await (await objectStore()).send(
      new PutObjectCommand({ Bucket: bucket(), Key: blobKey(digest), Body: buffer })
    );
    return { stored: true };
  }

  await ensureDir();
  const file = blobPath(digest);
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
  if (objectStoreConfigured()) return readFromObjectStore(blobKey(digest));
  return fs.readFile(blobPath(digest));
}

export async function hasBlob(digest) {
  if (objectStoreConfigured()) {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await (await objectStore()).send(
        new HeadObjectCommand({ Bucket: bucket(), Key: blobKey(digest) })
      );
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.access(blobPath(digest));
    return true;
  } catch {
    return false;
  }
}

function differentContentKeyError() {
  const error = new Error('Ciphertext already has a different sealed content key; refusing to replace it.');
  error.code = 'CONTENT_KEY_CONFLICT';
  return error;
}

async function acceptExistingContentKey(digest, sealedBase64) {
  const previous = openKey(await getSealedKey(digest));
  const proposed = openKey(sealedBase64);
  if (previous.toLowerCase() === proposed.toLowerCase()) return false;
  throw differentContentKeyError();
}

/** Write a sealed key once; retries are safe only when they unwrap to the same key. */
export async function putSealedKey(digest, sealedBase64) {
  if (objectStoreConfigured()) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await (await objectStore()).send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: sealedKeyKey(digest),
          Body: sealedBase64,
          IfNoneMatch: '*',
        })
      );
      return true;
    } catch (error) {
      if (
        error?.$metadata?.httpStatusCode === 412 ||
        error?.$metadata?.httpStatusCode === 409 ||
        error?.name === 'PreconditionFailed' ||
        error?.name === 'ConditionalRequestConflict'
      ) {
        return acceptExistingContentKey(digest, sealedBase64);
      }
      throw error;
    }
  }
  await ensureDir();
  try {
    await fs.writeFile(keyPath(digest), sealedBase64, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return acceptExistingContentKey(digest, sealedBase64);
    throw error;
  }
}

export async function getSealedKey(digest) {
  if (objectStoreConfigured()) {
    const bytes = await readFromObjectStore(sealedKeyKey(digest));
    return bytes.toString('utf8');
  }
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
