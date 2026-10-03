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
  { bytes: [0x42, 0x4d], mime: 'image/bmp' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], mime: 'image/tiff' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], mime: 'image/tiff' },
  { bytes: [0x00, 0x00, 0x01, 0x00], mime: 'image/x-icon' },
  // ISO base media: AVIF and HEIC carry their brand four bytes in.
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
];

/**
 * Formats a browser will not render, however it is handed to them.
 *
 * DOCX and the other Office files are ZIP containers. Inline display would need the
 * document's text extracted, or a third-party viewer fetched over the network with a
 * public URL to the file -- and the whole point of this record is that no such URL
 * exists. So they are classified rather than guessed at, and the console offers the
 * download instead of a blank frame.
 */
const OFFICE = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
]);

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

const kindOf = (mime) =>
  OFFICE.has(mime) ? 'office' : mime === 'application/pdf' ? 'pdf' : 'image';

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

  // Every `image/*` is offered to an <img>, because that is the one place a browser
  // decodes an image safely -- no script in an SVG runs inside an <img>. Office files
  // are named so the caller can say "download this" rather than show an empty frame.
  if (declared.startsWith('image/') || declared === 'application/pdf' || OFFICE.has(declared)) {
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
