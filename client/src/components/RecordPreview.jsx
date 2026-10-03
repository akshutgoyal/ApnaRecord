import React, { useEffect, useMemo, useState } from 'react';
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
  const [url, setUrl] = useState(null);

  // The URL is minted inside the effect, not memoised outside it.
  //
  // Memoising it made the same string on every run, and React StrictMode runs this effect
  // twice on mount -- mount, cleanup, mount. The cleanup revoked the one and only URL, the
  // second run produced the identical memoised value, and the <img> was left pointing at a
  // revoked blob. The bytes were fine, the decryption was fine, and the picture was an
  // empty box.
  //
  // Minting per run fixes the shape: each run owns a URL and revokes the one it made, so a
  // double invocation leaves exactly one live URL and the element points at it.
  useEffect(() => {
    if (!preview) {
      setUrl(null);
      return undefined;
    }
    const next = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [preview, bytes]);

  // An Office file has no inline rendering. Returning null rather than framing it is
  // deliberate: a blank <iframe> looks like a failure, and the caller can say "this one
  // downloads" instead. Nothing here can preview it -- the alternative is a third-party
  // viewer, which would need a public URL to a record whose whole point is that no such
  // URL exists.
  if (!preview || !url || preview.kind === 'office') return null;

  const label = fileName || 'Record';

  // A speed bump, not a control, and scoped to this element rather than the whole site.
  //
  // The bytes a browser is showing are already in the page -- there is no path to hide.
  // This only stops the casual "right click, save image as", and anyone who knows F12 is
  // past it in a second. Blocking the context menu site-wide would cost every honest
  // interaction (copy, open in new tab, spell-check) to buy nothing here.
  const deterrent = {
    onContextMenu: (e) => e.preventDefault(),
    onDragStart: (e) => e.preventDefault(),
  };

  if (preview.kind === 'image') {
    return (
      <img
        src={url}
        alt={label}
        draggable={false}
        {...deterrent}
        className="max-h-[32rem] w-full rounded-md border border-line bg-slate-50 object-contain"
      />
    );
  }

  return (
    <iframe
      src={url}
      title={label}
      {...deterrent}
      className="h-[32rem] w-full rounded-md border border-line bg-slate-50"
    />
  );
}
