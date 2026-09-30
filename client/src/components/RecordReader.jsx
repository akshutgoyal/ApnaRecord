import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { releaseFile } from '../services/api';
import { useChain } from '../chain';
import { decryptRecord, fromBase64, formatBytes, digestOf } from '../crypto';
import { TX_EXPLORER } from '../contract';
import { absoluteTime, relativeTime, humanType, shortAddress } from '../lib/format';
import { Callout, Pill, Spinner, Status } from './ui';

/**
 * The report reader.
 *
 * This is the point at which a record stops being a row in a table and becomes
 * something a human reads. Everything about it is therefore literal:
 *
 *  - it PROVES the caller is the viewer before asking for anything. Naming an
 *    address is not enough: consented addresses are public on-chain, so a claim
 *    was previously the whole of the attack.
 *  - it asks the contract every time. There is no cached permission, so a window
 *    that closed while the page was open closes here too.
 *  - a refusal is rendered as the specific refusal it was — "not granted" and
 *    "window closed" are different facts with different next actions, and
 *    collapsing them into "access denied" is how a clinician ends up unable to
 *    tell a permissions problem from an outage.
 *  - when the bytes are not text (a scan, a PDF), it says so and offers the
 *    decrypted file rather than rendering mojibake into a medical record.
 *  - the digest it verifies against is shown, because "this is the right record"
 *    is a claim the reader should be able to check.
 */
export default function RecordReader({ tokenId, viewer, record, onBack, backLabel = 'Back' }) {
  const { signRead, isDemo } = useChain();
  const [state, setState] = useState({ phase: 'loading' });

  const load = useCallback(async () => {
    if (!tokenId || !viewer) {
      setState({
        phase: 'refused',
        code: 'NoViewer',
        message: 'No wallet is attached to this session, so there is nobody to ask the contract about.',
      });
      return;
    }

    // A demo persona holds no key, so it cannot prove anything. That is the gate
    // working rather than a bug, and the panel below explains it in those terms —
    // a walkthrough should teach the security property, not apologise for it.
    if (isDemo) {
      setState({
        phase: 'refused',
        code: 'DemoHoldsNoKey',
        message:
          'A demo persona has no key, so it cannot sign the proof that it is this viewer. ' +
          'The contract\u2019s own verdict — "not granted", "window closed" — is only reached ' +
          'once you can prove who is asking. Sign in with a real wallet to see it.',
        isDemoNote: true,
      });
      return;
    }

    setState({ phase: 'loading' });
    try {
      // Prove we are the viewer. This is the step that used to be missing: the
      // server verified the *address* against the contract but never verified that
      // the caller controlled it.
      const proof = await signRead(tokenId, viewer);
      const released = await releaseFile(tokenId, viewer, proof);
      const bytes = fromBase64(released.ciphertext);

      // Text versus binary is a real distinction here, not a nicety: an X-ray is
      // not text, and a decoder will happily emit replacement characters for it.
      const decoded = new TextDecoder('utf-8').decode(bytes);
      const replacementRatio = (decoded.match(/\uFFFD/g) || []).length / Math.max(decoded.length, 1);
      const hasControlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
      const isText = replacementRatio < 0.01 && !hasControlChars;

      setState({
        phase: 'ready',
        released,
        bytes,
        text: isText ? decoded : null,
        isText,
        // Recompute the digest of what actually arrived. If it matches the value
        // the contract released, the bytes are provably the ones that were
        // registered — and the reader gets that proof for the price of one hash.
        digestMatches: digestOf(bytes) === released.recordHash,
      });
    } catch (error) {
      setState({
        phase: 'refused',
        code: error.code || 'REQUEST_FAILED',
        status: error.status,
        message: error.message,
        payload: error.payload,
      });
    }
  }, [tokenId, viewer, signRead, isDemo]);

  useEffect(() => {
    load();
  }, [load]);

  const download = () => {
    if (state.phase !== 'ready') return;
    const blob = new Blob([state.bytes], {
      type: state.released.mimeType || 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = state.released.fileName || `record-${tokenId}.bin`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------- record header */}
      <section className="rounded-lg border border-line bg-white p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="peacock">Token #{tokenId}</Pill>
          <span className="text-sm font-semibold text-ink">
            {humanType(record?.recordType)}
          </span>
          {record?.locked && <Status state="expired">soulbound</Status>}
          {onBack && (
            <button type="button" onClick={onBack} className="btn-ghost ml-auto text-xs">
              ← {backLabel}
            </button>
          )}
        </div>

        <dl className="mt-3 grid gap-x-5 gap-y-2 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Ordered by
            </dt>
            <dd className="text-xs text-slate-700">
              {record?.orderedByLabel || (record?.orderedBy ? shortAddress(record.orderedBy) : '—')}
              {record?.orderedAt && (
                <span className="text-slate-500"> · {absoluteTime(record.orderedAt)}</span>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Issued
            </dt>
            <dd className="text-xs text-slate-700">
              {record?.mintedAt ? absoluteTime(record.mintedAt) : `block ${record?.mintedAtBlock ?? '—'}`}
              {record?.mintedAtBlock && (
                <span className="text-slate-500"> · block {record.mintedAtBlock}</span>
              )}
            </dd>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Owner
            </dt>
            <dd className="mono break-all text-slate-700">{record?.patient || state.released?.patient}</dd>
          </div>
        </dl>
      </section>

      {/* ---------------------------------------------------------- the body */}
      {state.phase === 'loading' && (
        <Callout tone="info" title="Asking the contract">
          <span className="inline-flex items-center gap-2">
            <Spinner /> The server is running <span className="mono">viewRecord</span> as your address
            before it touches the file.
          </span>
        </Callout>
      )}

      {state.phase === 'refused' && <Refusal state={state} onRetry={load} record={record} />}

      {state.phase === 'ready' && (
        <>
          {!state.digestMatches && (
            <Callout tone="danger" title="These bytes do not match the on-chain digest">
              The file that arrived does not hash to the value the contract anchored. Do not rely on
              it. This is the failure the verifier exists to catch, and it has caught one.
            </Callout>
          )}

          {state.isText ? (
            <section className="rounded-lg border border-line bg-white">
              <header className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5">
                <h3 className="text-xs font-semibold text-ink">Report contents</h3>
                <Pill tone="success">consent verified by the contract</Pill>
                <Pill tone="slate">{formatBytes(state.released.sizeBytes)}</Pill>
                <button type="button" onClick={download} className="btn-secondary ml-auto text-xs">
                  Download
                </button>
              </header>
              <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap px-3.5 py-3 text-[12px] leading-relaxed text-slate-700">
                {state.text}
              </pre>
            </section>
          ) : (
            <section className="rounded-lg border border-line bg-white p-3.5">
              <h3 className="text-xs font-semibold text-ink">This record is not text</h3>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
                The contract released it and it decrypted cleanly, but the contents are binary —
                a scan or an image, most likely. Rendering that as text would produce nonsense, so
                the file is offered instead.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={download} className="btn-primary">
                  Download {state.released.fileName || `record-${tokenId}.bin`}
                </button>
                <Pill tone="slate">{state.released.mimeType || 'application/octet-stream'}</Pill>
                <Pill tone="slate">{formatBytes(state.released.sizeBytes)}</Pill>
              </div>
            </section>
          )}

          <section className="rounded-lg border border-line bg-slate-50 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Status state={state.digestMatches ? 'active' : 'denied'}>
                {state.digestMatches ? 'Digest matches the chain' : 'Digest mismatch'}
              </Status>
              <Link to="/verify" className="btn-secondary ml-auto text-xs">
                Verify independently
              </Link>
            </div>
            <p className="mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Released by <span className="mono normal-case tracking-normal">{state.released.checkedBy}</span>
            </p>
            <p className="mono mt-1 break-all text-slate-600">{state.released.recordHash}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              The file location the contract released was{' '}
              <span className="mono">{state.released.cid || '(empty)'}</span>. The bytes were
              decrypted in this browser — the server never held the plaintext.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Refusals, named precisely.
 *
 * Each of these is a different operational situation. "Access denied" as a single
 * catch-all is why people escalate the wrong things.
 */
function Refusal({ state, onRetry, record }) {
  const map = {
    AccessDenied: {
      tone: 'accent',
      title: 'No consent window is open to you',
      detail:
        'The record owner has not granted this wallet access to this record. Only the patient can open a window — an administrator cannot do it for them, and neither can we.',
      next: 'Ask the patient to grant access from their Patient console.',
    },
    Expired: {
      tone: 'accent',
      title: 'The consent window has closed',
      detail:
        'Access existed and has lapsed. The contract stopped authorising the read at the moment the window ended — nothing was revoked by hand and nothing is broken.',
      next: 'Ask the patient to open a new window.',
    },
    NotAuthorized: {
      tone: 'danger',
      title: 'The contract refused this call',
      detail:
        'For a record read, that normally means the calling address is neither the owner nor a consented viewer.',
      next: 'Check you are connected with the wallet that was granted access.',
    },
    RecordNotFound: {
      tone: 'danger',
      title: 'That token does not exist',
      detail: 'There is no record at this token ID on this contract.',
    },
    BlobMissing: {
      tone: 'danger',
      title: 'The chain has this record, but this server does not have its bytes',
      detail:
        'The token was minted from a different machine, or the uploads directory was cleared. The record itself still exists on-chain — only the file is absent here.',
      next: 'Verify the digest against a copy of the file you hold, or re-upload it from the Admin console.',
    },
    ChainUnavailable: {
      tone: 'danger',
      title: 'The contract could not be reached',
      detail:
        'This is an outage on the read path, not a permission problem. Nothing has been refused — the question could not be asked.',
      next: 'Try again in a moment.',
    },
    NoViewer: {
      tone: 'warn',
      title: 'No wallet attached',
      detail:
        'The server cannot act as a viewer without an address to ask the contract about, so no read can be attempted.',
    },
    DemoHoldsNoKey: {
      tone: 'warn',
      title: 'A demo persona cannot read a record',
      detail:
        'Reading is not a claim, it is a proof: the caller must sign a statement that they hold the viewer\u2019s key. A demo persona is a walkthrough with no key, so there is nothing to sign with. This is the gate working, not a fault.',
      next: 'Sign in with a real wallet to see the contract\u2019s own verdict on this record.',
    },
    ProofRequired: {
      tone: 'danger',
      title: 'The read signature was refused',
      detail:
        'The server could not accept the proof that you are this viewer. Usually the signature went stale before the request arrived, or it was made by a different wallet than the one named.',
      next: 'Press Check again to sign a fresh proof.',
    },
    API_DOWN: {
      tone: 'danger',
      title: 'The backend is unreachable',
      detail: 'The API that mediates the consent check is not responding.',
    },
  };

  const entry = map[state.code] || {
    tone: 'danger',
    title: `Refused: ${state.code || 'unknown'}`,
    detail: state.message || 'The request was refused without a recognised reason.',
  };

  return (
    <Callout
      tone={entry.tone}
      title={entry.title}
      action={
        // Retrying a demo persona would loop forever — there will never be a key
        // to sign with — so the button is withheld rather than offered and useless.
        state.isDemoNote ? null : (
          <button type="button" onClick={onRetry} className="btn-secondary">
            Check again
          </button>
        )
      }
    >
      <p>{entry.detail}</p>
      {entry.next && (
        <p className="mt-2 font-medium">
          <span className="opacity-70">What to do: </span>
          {entry.next}
        </p>
      )}
      {state.message && state.message !== entry.detail && (
        <p className="mt-2 text-[11px] opacity-80">{state.message}</p>
      )}
      {record?.orderedByLabel && state.code === 'AccessDenied' && (
        <p className="mt-2 text-[11px] opacity-80">
          Requested by {record.orderedByLabel}
          {record.orderedAt ? ` on ${absoluteTime(record.orderedAt)}` : ''}.
        </p>
      )}
    </Callout>
  );
}
