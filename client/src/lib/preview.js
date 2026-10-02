/**
 * What can the browser actually display?
 *
 * Two consoles decrypt a record — the reader, and the patient's own view of a
 * record they own. The reader knew that text and binary are different things, and
 * said so in a comment; the patient screen did not, and ran every record through a
 * UTF-8 decoder. A PNG passed through `TextDecoder` produces replacement
 * characters and mojibake, which is what the patient saw instead of their own scan.
 *
 * So the classification lives here, once, and both call it.
 *
 * The declared MIME type is trusted when it is specific. When it is absent or
 * generic — an upload with no type arrives as `application/octet-stream` — the
 * bytes are sniffed, because a file that IS a PNG should be shown as one even when
 * nobody labelled it.
 */

const SIGNATURES = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
];

const startsWith = (bytes, signature) =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);

/** RIFF is a container; only WEBP is an image. */
const isWebp = (bytes) =>
  bytes.length >= 12 &&
  startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
  bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;

function sniff(bytes) {
  if (isWebp(bytes)) return 'image/webp';
  const hit = SIGNATURES.find((s) => startsWith(bytes, s.bytes));
  return hit ? hit.mime : null;
}

const kindOf = (mime) => (mime === 'application/pdf' ? 'pdf' : 'image');

/**
 * Returns { kind, mimeType } when the bytes can be shown, or null when they cannot.
 *
 * `kind` is what to render with — an <img> or an embedded frame. Returning null is
 * not a failure: it means the honest thing is a download, and the caller should say
 * so rather than guess at a viewer.
 */
export function previewOf(mimeType, bytes) {
  if (!bytes || !bytes.length) return null;

  const declared = String(mimeType || '').toLowerCase().split(';')[0].trim();

  if (declared.startsWith('image/') || declared === 'application/pdf') {
    return { kind: kindOf(declared), mimeType: declared };
  }

  const sniffed = sniff(bytes);
  return sniffed ? { kind: kindOf(sniffed), mimeType: sniffed } : null;
}

/**
 * Is this binary? The complement of "safe to put in a <pre>".
 *
 * Kept next to the preview because they answer the same question from opposite
 * ends, and because the reader's inline version of this check is what the patient
 * screen was missing.
 */
export function looksLikeText(bytes) {
  const decoded = new TextDecoder('utf-8').decode(bytes);
  const replacementRatio = (decoded.match(/\uFFFD/g) || []).length / Math.max(decoded.length, 1);
  const hasControlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
  return replacementRatio < 0.01 && !hasControlChars;
}
