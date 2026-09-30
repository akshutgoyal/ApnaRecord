import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useChain, describeError } from '../chain';
import { listRecords, auditRecord, chainEvents } from '../services/api';
import { TX_EXPLORER } from '../contract';
import { useTx } from '../hooks/useTx';
import {
  Callout,
  Card,
  EmptyState,
  PageHeader,
  Pill,
  SkeletonRows,
  Status,
} from '../components/ui';
import { DataTable } from '../components/viz/primitives';

// The auditor's surface.
//
// Two registers, kept deliberately separate:
//
//   ACTIVITY  — what happened, newest first, scannable.
//   AUDIT LOG — the same events as an immutable ledger: ordered by block, with
//               the full argument set, never summarised away.
//
// The distinction matters because a log that can be reworded proves nothing. This
// page never edits an event — it can only render what the chain already says.

export default function Auditor() {
  const { account, roles, writeContract } = useChain();
  const { run, isBusy } = useTx();

  const [records, setRecords] = useState([]);
  const [audits, setAudits] = useState({});
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [register, setRegister] = useState('log');

  const isAuditor = roles.auditor;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ records: all }, { events: log }] = await Promise.all([
        listRecords(),
        chainEvents({ limit: 100 }),
      ]);
      setRecords(all);
      setEvents(log);

      // Every record's metadata, which is all an auditor is ever given.
      const collected = {};
      for (const record of all) {
        try {
          collected[record.tokenId] = await auditRecord(record.tokenId);
        } catch {
          /* a record we cannot read metadata for simply shows fewer fields */
        }
      }
      setAudits(collected);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * The point of this button: a wallet without AUDITOR_ROLE is refused by the
   * contract. The page could have hidden it, but hiding it would prove nothing.
   */
  const tryAuditCall = (tokenId) =>
    run(
      `auditRecord #${tokenId}`,
      async () => {
        const contract = await writeContract();
        try {
          await contract.auditRecord.staticCall(tokenId);
          return 'allowed';
        } catch (error) {
          return describeError(error).title;
        }
      },
      {
        successTitle: (result) =>
          result === 'allowed' ? 'The contract allowed it' : 'Refused by the contract',
        successDetail: (result) =>
          result === 'allowed'
            ? 'This wallet holds AUDITOR_ROLE. Note what came back: hash, type, time and owner — and no file location.'
            : `The call reverted with "${result}". The website did not hide the button; the contract rejected the call.`,
      }
    );

  const eventRows = useMemo(
    () =>
      events.map((event) => ({
        ...event,
        args: Object.entries(event.args || {})
          .filter(([, value]) => value !== '' && value !== null)
          .map(([key, value]) => `${key}=${value}`)
          .join('  '),
      })),
    [events]
  );

  const uniqueActors = useMemo(() => {
    const set = new Set();
    for (const event of events) {
      for (const key of ['viewer', 'requester', 'admin', 'patient', 'account']) {
        const value = event.args?.[key];
        if (typeof value === 'string' && value.startsWith('0x')) set.add(value.toLowerCase());
      }
    }
    return set.size;
  }, [events]);

  return (
    <>
      <PageHeader
        kicker="Compliance · Auditor"
        title="Audit view"
        lead="An auditor can prove a record is authentic and see everything that happened to it, without ever being able to read it. That separation is enforced by the contract, not promised by policy."
        aside={
          <button type="button" onClick={load} className="btn-secondary">
            Refresh
          </button>
        }
      />

      <Callout tone="info" className="mb-5" title="Metadata only — by design">
        The auditor view returns the digest, the record type, the mint time and the owner. It never
        returns the file location, so there is no path from this page to the document. Solidity
        <span className="mono"> private </span>
        only removes the CID from the ABI — encryption is what actually protects the file, and the
        contract gates the location.
      </Callout>

      {account && !isAuditor && (
        <Callout tone="warn" className="mb-5" title="This wallet does not hold AUDITOR_ROLE">
          Press the audit check on any record below and watch the contract refuse it. That refusal is
          the feature.
        </Callout>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-white p-4 shadow-card">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Records</p>
          <p className="font-display mt-1.5 text-[28px] font-bold leading-none tabular-nums text-ink">
            {records.length}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4 shadow-card">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Events on record
          </p>
          <p className="font-display mt-1.5 text-[28px] font-bold leading-none tabular-nums text-ink">
            {events.length}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4 shadow-card">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Distinct actors seen
          </p>
          <p className="font-display mt-1.5 text-[28px] font-bold leading-none tabular-nums text-ink">
            {uniqueActors}
          </p>
        </div>
      </div>

      <Card
        title="Record metadata"
        subtitle="Hash, type, time and owner. The file location is withheld by the contract."
        right={<Pill tone="slate">{records.length} records</Pill>}
      >
        {loading && records.length === 0 ? (
          <SkeletonRows rows={4} columns={4} />
        ) : (
          <DataTable
            freezeFirstColumn
            rowKey={(row) => row.tokenId}
            rows={records}
            empty="No records to audit yet"
            emptyFiltered="No records match this filter."
            columns={[
              {
                key: 'tokenId',
                label: 'Token',
                render: (row) => <Pill tone="slate">#{row.tokenId}</Pill>,
              },
              { key: 'recordType', label: 'Type' },
              {
                key: 'patient',
                label: 'Owner',
                mono: true,
                render: (row) => <span className="block max-w-[12rem] truncate">{row.patient}</span>,
              },
              {
                key: 'recordHash',
                label: 'Digest',
                mono: true,
                render: (row) => <span className="block max-w-[14rem] truncate">{row.recordHash}</span>,
              },
              {
                key: 'cid',
                label: 'File location',
                align: 'center',
                render: () => <Status state="denied">Withheld</Status>,
              },
              { key: 'mintedAtBlock', label: 'Block', align: 'right' },
              {
                key: 'audit',
                label: '',
                align: 'right',
                render: (row) =>
                  audits[row.tokenId] ? (
                    <span className="text-[10px] font-medium text-success-700">metadata ✓</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => tryAuditCall(row.tokenId)}
                      disabled={isBusy(`auditRecord #${row.tokenId}`)}
                      className="text-[11px] font-medium text-peacock-700 underline decoration-dotted underline-offset-2"
                    >
                      {isBusy(`auditRecord #${row.tokenId}`) ? 'Asking…' : 'Call auditRecord'}
                    </button>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        className="mt-5"
        title="The complete event log"
        subtitle="Ordered by block. Nobody maintains this — the chain is the log."
        right={
          <div className="flex items-center gap-1 rounded-lg border border-line bg-slate-50 p-0.5">
            {[
              { key: 'log', label: 'Ledger' },
              { key: 'feed', label: 'Feed' },
            ].map((mode) => (
              <button
                key={mode.key}
                type="button"
                aria-pressed={register === mode.key}
                onClick={() => setRegister(mode.key)}
                className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                  register === mode.key ? 'bg-white text-ink shadow-sm' : 'text-slate-500 hover:text-ink'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        }
      >
        {loading && events.length === 0 ? (
          <SkeletonRows rows={6} columns={3} />
        ) : register === 'log' ? (
          <DataTable
            rowKey={(row, index) => `${row.txHash}-${index}`}
            rows={eventRows}
            empty="No events yet"
            columns={[
              {
                key: 'blockNumber',
                label: 'Block',
                align: 'right',
                render: (row) => <span className="tabular-nums">{row.blockNumber}</span>,
              },
              { key: 'name', label: 'Event', render: (row) => <Pill tone="slate">{row.name}</Pill> },
              {
                key: 'args',
                label: 'Arguments (verbatim)',
                mono: true,
                render: (row) => <span className="block max-w-[26rem] truncate">{row.args}</span>,
              },
              {
                key: 'tx',
                label: '',
                align: 'right',
                render: (row) => (
                  <a
                    href={`${TX_EXPLORER}${row.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-peacock-700 underline decoration-dotted underline-offset-2"
                  >
                    etherscan ↗
                  </a>
                ),
              },
            ]}
          />
        ) : (
          <ol className="space-y-0">
            {eventRows.length === 0 ? (
              <EmptyState title="No events yet" />
            ) : (
              eventRows.map((row, index) => (
                <li
                  key={`${row.txHash}-${index}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-0"
                >
                  <span className="mono w-20 shrink-0 text-slate-400">#{row.blockNumber}</span>
                  <span className="text-xs font-semibold text-ink">{row.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600">{row.args}</span>
                </li>
              ))
            )}
          </ol>
        )}

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Blocks are shown rather than relative times on purpose. A ledger entry needs an absolute,
          verifiable position — "3 hours ago" is a presentation choice, and a block number is not.
        </p>
      </Card>
    </>
  );
}
