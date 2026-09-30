import React, { useCallback, useEffect, useState } from 'react';
import { digestOf, formatBytes } from '../crypto';
import { listRecords, verifyDigest } from '../services/api';
import { CONTRACT_ADDRESS, EXPLORER } from '../contract';
import { Callout, Card, EmptyState, Field, PageHeader, Pill, Skeleton } from '../components/ui';

// The free, permissionless primitive. No wallet, no account, no consent — a
// verifier that does not trust the issuing hospital can still check a file.
//
// The digest is keccak256 of the ENCRYPTED file, because that is the artifact the
// chain anchors. So the file to drop here is the encrypted record you were given,
// not the plaintext scan. That is the design: the chain never learns anything
// about the contents.

export default function Verify() {
  const [records, setRecords] = useState([]);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [tokenId, setTokenId] = useState('1');
  const [file, setFile] = useState(null);
  const [localDigest, setLocalDigest] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadRecords = useCallback(async () => {
    try {
      const { records: all } = await listRecords();
      setRecords(all);
      if (all.length > 0) {
        setTokenId((current) =>
          all.some((r) => String(r.tokenId) === String(current)) ? current : String(all[0].tokenId)
        );
      }
    } catch {
      setRecords([]);
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  const check = useCallback(
    async (digest, note) => {
      setBusy(true);
      setError(null);
      try {
        const verdict = await verifyDigest(Number(tokenId), digest);
        setResult({ ...verdict, note });
      } catch (requestError) {
        setError(requestError.message);
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [tokenId]
  );

  const pickFile = async (chosen) => {
    setFile(chosen || null);
    setResult(null);
    setError(null);
    if (!chosen) {
      setLocalDigest('');
      return;
    }
    const buffer = await chosen.arrayBuffer();
    const digest = digestOf(buffer);
    setLocalDigest(digest);
    await check(digest, `you dropped ${chosen.name} (${formatBytes(chosen.size)})`);
  };

  const useOnChainDigest = () => {
    const record = records.find((r) => String(r.tokenId) === String(tokenId));
    if (!record) return;
    setFile(null);
    setLocalDigest(record.recordHash);
    check(record.recordHash, 'the digest read from the chain');
  };

  const tamper = () => {
    // Flip the last hex character. One bit, and the record is no longer authentic.
    const record = records.find((r) => String(r.tokenId) === String(tokenId));
    if (!record) return;
    const last = record.recordHash.slice(-1);
    const flipped = (parseInt(last, 16) ^ 0x1).toString(16);
    const tampered = record.recordHash.slice(0, -1) + flipped;
    setFile(null);
    setLocalDigest(tampered);
    check(tampered, 'the same digest with exactly one bit changed');
  };

  return (
    <>
      <PageHeader
        kicker="Public utility"
        title="Verify a record without an account"
        lead="Rehash the file and compare it with the 32 bytes on-chain. A match means the file is exactly what was registered; a mismatch means it was altered, even by us. No wallet, no login, and nothing to trust but arithmetic."
        aside={
          <a href={EXPLORER} target="_blank" rel="noreferrer" className="btn-secondary">
            View the contract
          </a>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Check a file"
          subtitle="Free, permissionless, and identical for everyone."
        >
          <div className="space-y-4">
            <Field label="Which record">
              {recordsLoading ? (
                <div className="flex flex-wrap gap-1.5">
                  <Skeleton className="h-6 w-24 rounded-full" />
                  <Skeleton className="h-6 w-28 rounded-full" />
                  <Skeleton className="h-6 w-20 rounded-full" />
                </div>
              ) : records.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No records are registered on this contract yet, so there is nothing to check
                  against. The panel on the right explains the mechanism.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {records.map((record) => {
                    const selected = String(record.tokenId) === String(tokenId);
                    return (
                      <button
                        key={record.tokenId}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setTokenId(String(record.tokenId));
                          setResult(null);
                          setError(null);
                        }}
                        className={`rounded-institutional border px-2.5 py-1 text-[11px] font-medium transition ${
                          selected
                            ? 'border-peacock-300 bg-peacock-50 text-peacock-700'
                            : 'border-line bg-slate-50 text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        #{record.tokenId} · {record.recordType}
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>

            <Field
              label="Drop the encrypted record file"
              hint="The chain anchors keccak256 of the encrypted file, so this is the file to check — not the plaintext scan."
            >
              <input
                type="file"
                onChange={(event) => pickFile(event.target.files?.[0] || null)}
                className="block w-full cursor-pointer rounded-lg border border-line-strong bg-white text-xs text-slate-600 file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              />
            </Field>

            {file && (
              <div className="flex items-center gap-2 rounded-lg border border-line bg-slate-50 px-3 py-2">
                <Pill tone="slate">{formatBytes(file.size)}</Pill>
                <span className="truncate text-xs text-slate-600">{file.name}</span>
              </div>
            )}

            {localDigest && (
              <div className="rounded-lg border border-line bg-slate-50 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Digest computed in your browser
                </p>
                <p className="mono mt-1 break-all text-slate-700">{localDigest}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => localDigest && check(localDigest, 'the digest shown above')}
                disabled={!localDigest || busy}
                className="btn-primary"
              >
                {busy ? 'Asking the contract…' : 'Verify this digest'}
              </button>
              <button
                type="button"
                onClick={useOnChainDigest}
                disabled={busy || records.length === 0}
                className="btn-secondary"
              >
                Use the on-chain digest
              </button>
              <button
                type="button"
                onClick={tamper}
                disabled={busy || records.length === 0}
                className="btn-secondary border-error-200 text-error-700 hover:bg-error-50"
              >
                Tamper with one bit
              </button>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          {error && (
            <Callout tone="danger" title="Could not verify">
              {error}
            </Callout>
          )}

          {busy && !result && (
            <Card>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-4/5" />
            </Card>
          )}

          {!result && !error && !busy && (
            <Card>
              <EmptyState
                title="No verdict yet"
                hint="Drop a file, or use the buttons to compare the on-chain digest with itself and with a single altered bit."
              />
            </Card>
          )}

          {result && (
            <>
              <Card tone={result.authentic ? 'ok' : 'danger'}>
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg ${
                      result.authentic
                        ? 'bg-success-100 text-success-700'
                        : 'bg-error-100 text-error-700'
                    }`}
                  >
                    {result.authentic ? '✓' : '✕'}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`font-display text-[15px] font-bold ${
                        result.authentic ? 'text-success-700' : 'text-error-700'
                      }`}
                    >
                      {result.authentic
                        ? 'Authentic — this file is exactly what was registered'
                        : 'Tampered — this file is not the registered one'}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600">
                      Checked against token #{result.tokenId}. The verdict came from the contract's
                      own <span className="mono">verifyRecord</span> call — we did not compute the
                      comparison ourselves.
                    </p>
                    {result.note && (
                      <p className="mt-1.5 text-[11px] text-slate-500">Input: {result.note}</p>
                    )}
                  </div>
                </div>

                {/* The two digests, side by side, so a reader can see the one bit. */}
                <dl className="mt-4 space-y-2">
                  {[
                    { k: 'Digest provided', v: result.provided },
                    { k: 'Digest on-chain', v: result.onChain },
                  ].map((row) => (
                    <div key={row.k} className="rounded-lg border border-line bg-white p-3">
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {row.k}
                      </dt>
                      <dd className="mono mt-1 break-all text-slate-700">{row.v}</dd>
                    </div>
                  ))}
                </dl>

                {!result.authentic && result.provided !== result.onChain && (
                  <p className="mt-3 text-[11px] leading-relaxed text-error-700">
                    The two strings differ somewhere above. That difference is the whole proof: no
                    signature to forge, no log to edit, no administrator to convince.
                  </p>
                )}
              </Card>

              <Callout tone="info" title="What this proves, and what it does not">
                A match proves the bytes are unchanged since the record was registered — not that the
                diagnosis is correct, and not that the clinician was qualified. It answers exactly
                one question: has this file been altered? That is the question paper records cannot
                answer at all.
              </Callout>
            </>
          )}

          <Card title="Why the digest matters" subtitle="The 32-byte truth anchor.">
            <ul className="space-y-2.5 text-xs leading-relaxed text-slate-600">
              <li>
                When a record is registered, <span className="mono">keccak256</span> of the encrypted
                file is computed off-chain and only that 32-byte value is stored.
              </li>
              <li>
                Anyone can recompute it later and compare. A mismatch is detected even if the
                alteration happened inside our own database.
              </li>
              <li>
                The check is a free <span className="mono">view</span> call, so it costs nothing and
                needs no permission — which is why it works on this page with no wallet connected.
              </li>
            </ul>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <span className="status-active">
                {records.length} record{records.length === 1 ? '' : 's'} verifiable
              </span>
              <a
                href={EXPLORER}
                target="_blank"
                rel="noreferrer"
                className="mono truncate text-[10px] text-peacock-700 underline decoration-dotted underline-offset-2"
              >
                {CONTRACT_ADDRESS}
              </a>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
