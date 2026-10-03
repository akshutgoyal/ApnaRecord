import React, { useEffect, useMemo } from 'react';
import { previewOf } from '../lib/preview';

/**
 * The decrypted record, shown rather than dumped.
 *
 * Renders nothing when the bytes are not a displayable type — the caller decides
 * what to say instead, because "here is a download link" and "this format cannot be
 * shown" are different sentences and only the caller knows which fits.
 *
 * The object URL is created from the bytes in memory, so it works in the browser
 * that did the decryption and nowhere else. It is revoked when the bytes change or
 * the component unmounts; without that, a clinician clicking through twenty records
 * would leak twenty blobs.
 */
export default function RecordPreview({ bytes, mimeType, fileName }) {
  const preview = useMemo(() => previewOf(mimeType, bytes), [mimeType, bytes]);

  const url = useMemo(
    () => (preview ? URL.createObjectURL(new Blob([bytes], { type: preview.mimeType })) : null),
    [preview, bytes]
  );

  useEffect(() => {
    if (!url) return undefined;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  // An Office file has no inline rendering. Returning null rather than framing it is
  // deliberate: a blank <iframe> looks like a failure, and the caller can say "this one
  // downloads" instead. Nothing here can preview it -- the alternative is a third-party
  // viewer, which would need a public URL to a record whose whole point is that no such
  // URL exists.
  if (!preview || !url || preview.kind === 'office') return null;

  const label = fileName || 'Record';

  if (preview.kind === 'image') {
    return (
      <img
        src={url}
        alt={label}
        className="max-h-[32rem] w-full rounded-md border border-line bg-slate-50 object-contain"
      />
    );
  }

  return (
    <iframe
      src={url}
      title={label}
      className="h-[32rem] w-full rounded-md border border-line bg-slate-50"
    />
  );
}
