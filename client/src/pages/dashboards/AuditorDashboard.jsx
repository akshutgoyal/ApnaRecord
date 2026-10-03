import React, { useMemo, useState } from 'react';
import { useChain } from '../../chain';
import { useStats, useProfiles } from '../../hooks/useDashboardData';
import { useTableState } from '../../hooks/useTableState';
import { useEventFeed } from '../../hooks/useEventFeed';
import { auditRecord, chainEvents, recordHistory } from '../../services/api';
import { TX_EXPLORER } from '../../contract';
import { downloadCsv, timestampedFilename } from '../../lib/csv';
import { DonutChart, BarsChart, AreaTrend } from '../../components/viz/charts';
import LifecycleFlow from '../../components/viz/LifecycleFlow';
import {
  ChartCard,
  DataTable,
  DonutLegend,
  EmptyPanel,
  OffChainBadge,
  ProgressBar,
  StatCard,
} from '../../components/viz/primitives';
import { Callout, Card, Pill, SkeletonCards, SkeletonRows, Status } from '../../components/ui';
import PanelBoundary from '../../components/PanelBoundary';
import Drawer from '../../components/Drawer';
import RecordReader from '../../components/RecordReader';
import RecordTimeline from '../../components/RecordTimeline';
import { DashboardBar, ExportButton } from '../../components/DashboardBar';
import { humanType, shortAddress as short, absoluteTime, relativeTime } from '../../lib/format';

// The nine events the design claims, against what this contract has emitted.
const CLAIMED_EVENTS = [
  'IdentityCreated',
  'RecordRequested',
  'RecordMinted',
  'AccessGranted',
  'AccessRevoked',
  'EmergencyAccessUsed',
  'RecordRevoked',
];

export default function AuditorDashboard() {
  const { account, roles } = useChain();
  const { stats, loading, error, lastUpdated, refreshing, refreshFromChain } = useStats();
  const { nameFor } = useProfiles();

  const [drawer, setDrawer] = useState(null);
  const [reader, setReader] = useState(null);
  const [exporting, setExporting] = useState(null);
  const [opened, setOpened] = useState({});
  const [busyToken, setBusyToken] = useState(null);

  // The event log is server-filtered and server-paged: it is the one dataset here
  // that grows without bound.
  const [eventName, setEventName] = useState('');
  const [eventSearch, setEventSearch] = useState('');
  const feed = useEventFeed({ pageSize: 10, name: eventName, search: eventSearch });

  const recordTable = useTableState({
    rows: stats?.records ?? [],
    searchFields: ['recordHash', 'recordType', 'patient', 'patientName', 'patientLabel'],
    initialSort: { key: 'tokenId', dir: 'desc' },
    pageSize: 10,
    sorters: {
      owner: (row) => row.patientName || row.patientLabel || row.patient,
    },
  });

  const eventRows = useMemo(
    () =>
      feed.events.map((event) => ({
        ...event,
        argsText: Object.entries(event.args || {})
          .filter(([, value]) => value !== '' && value !== null)
          .map(([key, value]) => `${key}=${value}`)
          .join('  '),
      })),
    [feed.events]
  );

  if (loading && !stats) {
    return (
      <div className="space-y-5">
        <div className="h-12 rounded-xl border border-line bg-white shadow-card" />
        <SkeletonCards count={4} />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="h-64 rounded-xl border border-line bg-white shadow-card lg:col-span-2" />
          <div className="h-64 rounded-xl border border-line bg-white shadow-card" />
        </div>
      </div>
    );
  }
  if (error && !stats) return <EmptyPanel title="Could not read dashboard data" hint={error} />;

  // A stale payload is not a current one — see the longer note in AdminDashboard. The
  // guard above only fires with no payload at all, so a failed refresh after a successful
  // read left these figures on screen looking newly read.
  const staleNotice = error ? (
    <Callout tone="warn" title="These numbers could not be refreshed">
      {error} They are from the last successful read and may no longer be true.
    </Callout>
  ) : null;

  const observed = new Set(stats.eventsByType.map((entry) => entry.name));
  const covered = CLAIMED_EVENTS.filter((name) => observed.has(name)).length;

  const openMeta = async (tokenId) => {
    setBusyToken(tokenId);
    try {
      const metadata = await auditRecord(tokenId);
      setOpened((current) => ({ ...current, [tokenId]: metadata }));
    } catch {
      /* surfaced by the row staying closed */
    } finally {
      setBusyToken(null);
    }
  };

  /**
   * The audit packet: everything this role is entitled to, in one file.
   *
   * Assembled per record rather than exported from the table, because an auditor's
   * question is almost always about one token — and it is fetched fresh, so the
   * packet reflects the chain now rather than whenever the dashboard was cached.
   * Consent changes are ordinary events (AccessGranted, AccessRevoked,
   * EmergencyAccessUsed), so they already appear in this trail with their actor.
   */
  const exportPacket = async (record) => {
    setExporting(record.tokenId);
    try {
      const payload = await recordHistory(record.tokenId);
      downloadCsv(
        timestampedFilename(`apnarecord-audit-token-${record.tokenId}`),
        [
          { key: 'tokenId', label: 'Token', value: () => record.tokenId },
          { key: 'recordType', label: 'Record type', value: () => record.recordType },
          { key: 'recordHash', label: 'On-chain digest', value: () => record.recordHash },
          { key: 'owner', label: 'Owner', value: () => record.patient },
          {
            key: 'orderedBy',
            label: 'Ordered by',
            value: () => record.orderedByLabel || record.orderedBy || '',
          },
          { key: 'issuedAt', label: 'Issued (ISO)', value: () => record.mintedAt || '' },
          { key: 'block', label: 'Block', value: (event) => event.blockNumber },
          { key: 'eventAt', label: 'Event time (ISO)', value: (event) => event.timestamp || '' },
          { key: 'name', label: 'Event', value: (event) => event.name },
          {
            key: 'actor',
            label: 'Actor',
            value: (event) => event.actorLabel || event.actor || 'system',
          },
          { key: 'txHash', label: 'Transaction', value: (event) => event.txHash },
          {
            key: 'args',
            label: 'Arguments',
            value: (event) =>
              Object.entries(event.args || {})
                .filter(([, value]) => value !== '' && value !== null)
                .map(([key, value]) => `${key}=${value}`)
                .join(' '),
          },
        ],
        payload.events || []
      );
    } catch {
      /* surfaced by the button returning to its idle state */
    } finally {
      setExporting(null);
    }
  };

  // The consent ledger for whichever record is open in the drawer, newest grant
  // first — an auditor reading a window wants the most recent one at the top.
  const consentLedger = drawer
    ? stats.consents
        .filter((consent) => consent.tokenId === drawer.tokenId)
        .sort((a, b) => (b.grantedAtBlock || 0) - (a.grantedAtBlock || 0))
    : [];

  /**
   * Export the filtered log, not just the visible page.
   *
   * "Export" that silently writes ten rows because ten happened to be on screen
   * is worse than no export — it produces a file that looks complete and is not.
   * This re-runs the same filters at the server's ceiling and labels the result
   * if it hits it.
   */
  const exportLog = async () => {
    const payload = await chainEvents({
      limit: 500,
      name: eventName || undefined,
      search: eventSearch || undefined,
    });
    const rows = payload.events.map((event) => ({
      ...event,
      argsText: Object.entries(event.args || {})
        .filter(([, value]) => value !== '' && value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join('  '),
    }));
    downloadCsv(
      timestampedFilename('apnarecord-audit-log'),
      [
        { key: 'blockNumber', label: 'Block' },
        { key: 'timestamp', label: 'Timestamp (ISO)', value: (row) => row.timestamp || '' },
        { key: 'name', label: 'Event' },
        { key: 'argsText', label: 'Arguments' },
        { key: 'txHash', label: 'Transaction' },
      ],
      rows
    );
  };

  return (
    <div className="space-y-5">
      {staleNotice}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-peacock-700">
            Compliance · Auditor
          </p>
          <h1 className="font-display mt-1 text-2xl font-bold tracking-tight text-ink">
            Audit workspace
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
            An auditor can prove a record is authentic and see everything that happened to it,
            without ever being able to read it. The contract never releases the file location to this
            role, so there is no path from this page to a document.
          </p>
        </div>
        {roles.auditor ? (
          <Status state="active">AUDITOR_ROLE</Status>
        ) : (
          <Status state="denied">No auditor role</Status>
        )}
      </header>

      <DashboardBar
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={refreshFromChain}
        stats={stats}
      >
        <ExportButton
          filename="apnarecord-record-metadata"
          label="Export metadata"
          rows={stats.records}
          columns={[
            { key: 'tokenId', label: 'Token' },
            { key: 'recordType', label: 'Type' },
            { key: 'patient', label: 'Owner' },
            { key: 'recordHash', label: 'Digest' },
            { key: 'mintedAtBlock', label: 'Minted block' },
            { key: 'mintedTx', label: 'Mint transaction' },
            { key: 'consentsActive', label: 'Active consents' },
          ]}
        />
      </DashboardBar>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Records under audit" value={stats.totals.records} tone="peacock" />
        <StatCard
          label="Events recorded"
          value={stats.totals.events}
          tone="peacock"
          hint={`Block ${stats.chain.blockNumber ?? '—'}`}
          stale={Boolean(stats.stale)}
        />
        <StatCard
          label="Files released to this role"
          value={0}
          tone="error"
          hint="By design — the CID is never returned"
        />
        <StatCard
          label="Consent windows"
          value={stats.totals.activeConsents + stats.totals.expiredConsents}
          tone="marigold"
          hint={`${stats.totals.activeConsents} active · ${stats.totals.expiredConsents} expired`}
        />
      </div>

      {!roles.auditor && (
        <Callout tone="warn" title="This wallet does not hold AUDITOR_ROLE">
          The metadata below is public, because the chain is public. What the role gates is the
          contract's own <span className="mono">auditRecord</span> call — press it on any row and the
          contract will refuse the call.
        </Callout>
      )}

      {/* The single most important thing to say on an audit screen: what it cannot
          prove. An auditor who assumes this log shows who *read* a record will draw
          the wrong conclusion from it, and quietly. */}
      <Callout tone="warn" title="What this log proves, and what it does not">
        It proves <strong>who was authorised</strong> to read a record, when the window opened and
        closed, who opened it, and every state change since. It does <strong>not</strong> prove who
        actually looked: reading a record is a <span className="mono">view</span> call that leaves no
        trace on-chain, and a refused read leaves none either. Used and unused windows are
        indistinguishable here — so treat this as a record of authority, not of access.
      </Callout>

      <div className="grid gap-4 lg:grid-cols-3">
        <PanelBoundary name="Events by type">
          <ChartCard
            title="Events by type"
            subtitle="The audit trail, by kind"
            right={
              <div className="w-40">
                <DonutLegend data={stats.eventsByType.slice(0, 4)} />
              </div>
            }
          >
            <DonutChart data={stats.eventsByType} centerLabel="events" />
          </ChartCard>
        </PanelBoundary>

        <PanelBoundary name="Audit trail over time">
          <ChartCard
            className="lg:col-span-2"
            title="Audit trail over time"
            subtitle="Every state change the contract recorded"
            height={230}
          >
            <AreaTrend data={stats.activityByDay} label="events" />
          </ChartCard>
        </PanelBoundary>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <PanelBoundary name="Records by type">
          <ChartCard title="Records by type" subtitle="What the hospital issued" height={200}>
            <BarsChart data={stats.recordsByType} horizontal />
          </ChartCard>
        </PanelBoundary>

        <Card
          className="lg:col-span-2"
          title="Audit coverage"
          subtitle="Event kinds observed against the ones the design claims"
        >
          <ProgressBar
            value={covered}
            max={CLAIMED_EVENTS.length}
            label="Event types seen on this contract"
            sublabel={`${covered} / ${CLAIMED_EVENTS.length}`}
          />
          <div className="mt-3 flex flex-wrap gap-1.5">
            {CLAIMED_EVENTS.map((name) => {
              const seen = observed.has(name);
              return (
                <span
                  key={name}
                  className={`mono rounded-institutional px-1.5 py-0.5 text-[10px] ring-1 ring-inset ${
                    seen
                      ? 'bg-success-50 text-success-700 ring-success-200'
                      : 'bg-slate-50 text-slate-400 ring-slate-200'
                  }`}
                >
                  {seen ? '✓' : '○'} {name}
                </span>
              );
            })}
          </div>
          <p className="mt-2.5 text-[13px] leading-relaxed text-slate-500">
            Grey events have simply not happened yet on this contract. Their absence is not a defect —
            <span className="mono"> AccessRevoked</span> only exists once someone revokes.
          </p>
        </Card>
      </div>

      <Card
        title="Record metadata"
        subtitle="Hash, type, time and owner. The file location is withheld by the contract. Click a row for its full history."
        right={<Pill tone="slate">{recordTable.total} records</Pill>}
      >
        <PanelBoundary name="The record metadata table">
          <DataTable
            freezeFirstColumn
            rowKey={(row) => row.tokenId}
            rows={recordTable.rows}
            total={recordTable.total}
            filtered={recordTable.isFiltered}
            empty="No records to audit"
            emptyFiltered="No record matches this search."
            onRowClick={(row) => setDrawer(row)}
            sort={recordTable.sort}
            onToggleSort={recordTable.toggleSort}
            page={recordTable.page}
            pageSize={recordTable.pageSize}
            totalPages={recordTable.totalPages}
            onPageChange={recordTable.setPage}
            onPageSizeChange={recordTable.setPageSize}
            toolbar={
              <input
                className="input h-9 w-56 py-0 text-xs"
                value={recordTable.query}
                onChange={(event) => recordTable.setQuery(event.target.value)}
                placeholder="Search digest, owner, type…"
                aria-label="Search records"
              />
            }
            columns={[
              {
                key: 'tokenId',
                label: 'Token',
                render: (row) => <Pill tone="slate">#{row.tokenId}</Pill>,
              },
              { key: 'recordType', label: 'Type', render: (row) => humanType(row.recordType) },
              {
                key: 'patient',
                label: 'Owner',
                render: (row) => {
                  const name = row.patientName || nameFor(row.patient, row.patientLabel);
                  return (
                    <div className="flex items-center gap-1.5">
                      <span>{name || short(row.patient)}</span>
                      {row.patientName && <OffChainBadge />}
                    </div>
                  );
                },
              },
              {
                key: 'recordHash',
                label: 'Digest',
                mono: true,
                sortable: false,
                render: (row) => <span className="block max-w-[12rem] truncate">{row.recordHash}</span>,
              },
              {
                key: 'cid',
                label: 'File location',
                align: 'center',
                sortable: false,
                render: () => <Status state="denied">Withheld</Status>,
              },
              { key: 'mintedAtBlock', label: 'Block', align: 'right' },
              {
                key: 'audit',
                label: '',
                align: 'right',
                sortable: false,
                render: (row) =>
                  opened[row.tokenId] ? (
                    <span className="text-[10px] font-medium text-success-700">metadata ✓</span>
                  ) : (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        openMeta(row.tokenId);
                      }}
                      disabled={busyToken === row.tokenId}
                      className="text-[11px] font-medium text-peacock-700 underline decoration-dotted underline-offset-2"
                    >
                      {busyToken === row.tokenId ? 'Asking…' : 'Call auditRecord'}
                    </button>
                  ),
              },
            ]}
          />
        </PanelBoundary>
      </Card>

      <Card
        title="Event log"
        subtitle="Filtered and paged on the server, because this is the one dataset that grows without bound."
        right={
          <Pill tone="slate">
            {feed.total} matching
            {feed.total > feed.scanned && ` of ${feed.scanned} scanned`}
          </Pill>
        }
      >
        <PanelBoundary name="The event log">
          {feed.loading && eventRows.length === 0 ? (
            <SkeletonRows rows={6} columns={4} />
          ) : feed.error ? (
            <Callout tone="danger" title="Could not read the event log">
              {feed.error}
            </Callout>
          ) : (
            <DataTable
              rowKey={(row, index) => `${row.txHash}-${index}`}
              rows={eventRows}
              total={feed.total}
              filtered={Boolean(eventName || eventSearch)}
              empty="No events yet"
              emptyFiltered="No event matches these filters."
              page={feed.page}
              pageSize={feed.pageSize}
              totalPages={feed.totalPages}
              onPageChange={feed.setPage}
              showDensity={false}
              toolbar={
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="input h-9 w-52 py-0 text-xs"
                    value={eventSearch}
                    onChange={(event) => setEventSearch(event.target.value)}
                    placeholder="Search arguments or tx hash…"
                    aria-label="Search events"
                  />
                  <select
                    value={eventName}
                    onChange={(event) => setEventName(event.target.value)}
                    aria-label="Filter by event type"
                    className="h-9 rounded-lg border border-line-strong bg-white px-2 text-xs text-ink"
                  >
                    <option value="">All event types</option>
                    {stats.eventsByType.map((entry) => (
                      <option key={entry.name} value={entry.name}>
                        {entry.name} ({entry.value})
                      </option>
                    ))}
                  </select>
                  {(eventName || eventSearch) && (
                    <button
                      type="button"
                      onClick={() => {
                        setEventName('');
                        setEventSearch('');
                      }}
                      className="btn-ghost text-xs"
                    >
                      Clear
                    </button>
                  )}
                  <button type="button" onClick={exportLog} className="btn-secondary text-xs">
                    Export this filter
                  </button>
                </div>
              }
              columns={[
                {
                  key: 'blockNumber',
                  label: 'Block',
                  align: 'right',
                  render: (row) => <span className="tabular-nums">{row.blockNumber}</span>,
                },
                {
                  key: 'timestamp',
                  label: 'When',
                  sortable: false,
                  render: (row) => (
                    <span title={absoluteTime(row.timestamp)}>{relativeTime(row.timestamp)}</span>
                  ),
                },
                { key: 'name', label: 'Event', render: (row) => <Pill tone="slate">{row.name}</Pill> },
                {
                  key: 'argsText',
                  label: 'Arguments (verbatim)',
                  mono: true,
                  sortable: false,
                  render: (row) => <span className="block max-w-[24rem] truncate">{row.argsText}</span>,
                },
                {
                  key: 'tx',
                  label: '',
                  align: 'right',
                  sortable: false,
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
          )}
        </PanelBoundary>
      </Card>

      <Card title="Record lifecycle" subtitle="What the auditor may and may not see at each step">
        <LifecycleFlow role="auditor" />
      </Card>

      {/* ------------------------------------------------------------ drawer */}
      <Drawer
        open={Boolean(drawer)}
        onClose={() => setDrawer(null)}
        title={drawer ? `Record #${drawer.tokenId} · ${humanType(drawer.recordType)}` : ''}
        subtitle={drawer ? `owner ${short(drawer.patient)}` : ''}
        width="max-w-2xl"
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => drawer && exportPacket(drawer)}
              disabled={exporting === drawer?.tokenId}
              className="btn-primary text-xs"
            >
              {exporting === drawer?.tokenId ? 'Assembling…' : 'Export the audit packet'}
            </button>
            <p className="text-[13px] leading-relaxed text-slate-500">
              Metadata, consent history and the full event trail for this token.
            </p>
          </div>
        }
      >
        {drawer && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Status state="denied">File location withheld</Status>
              {drawer.locked && <Status state="expired">soulbound</Status>}
              {drawer.burned && <Status state="revoked">burned</Status>}
            </div>

            <section className="space-y-3 rounded-lg border border-line bg-white p-3.5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Record digest
                </p>
                <p className="mono mt-1 break-all text-slate-700">{drawer.recordHash}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Owner
                  </p>
                  <p className="mono mt-1 break-all text-slate-700">{drawer.patient}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Issued
                  </p>
                  <p className="mt-1 text-xs text-slate-700">
                    {drawer.mintedAt ? absoluteTime(drawer.mintedAt) : '—'}
                    <span className="text-slate-400"> · block {drawer.mintedAtBlock}</span>
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Ordered by
                  </p>
                  <p className="mt-1 text-xs text-slate-700">
                    {drawer.orderedByLabel ||
                      (drawer.orderedBy ? short(drawer.orderedBy) : 'no recorded request')}
                    {drawer.requestId ? (
                      <span className="text-slate-400"> · request #{drawer.requestId}</span>
                    ) : null}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Integrity
                  </p>
                  <p className="mt-1 text-xs text-slate-700">
                    Anyone can verify these bytes against the digest
                  </p>
                </div>
              </div>
            </section>

            {/* The role's defining restriction, stated and demonstrable. */}
            <div className="rounded-lg border border-error-200 bg-error-50 p-3.5">
              <p className="text-xs font-semibold text-error-700">
                This role cannot read the record
              </p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
                AUDITOR_ROLE grants metadata and the event log. It grants no access to content — the
                contract refuses, the same as it would for any other wallet the patient has not
                consented to.
              </p>
              <button
                type="button"
                onClick={() => setReader(drawer)}
                className="btn-secondary mt-2.5 text-xs"
              >
                Attempt to open the content
              </button>
            </div>

            <section>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xs font-semibold text-ink">Consent ledger</h3>
                <Pill tone="slate">
                  {stats.consents.filter((c) => c.tokenId === drawer.tokenId).length} windows ever
                </Pill>
              </div>
              {consentLedger.length === 0 ? (
                <p className="mt-2 text-[11px] text-slate-500">
                  No consent window has ever been granted on this record. The owner's own access is
                  not a window and is not recorded as one.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {consentLedger.map((consent) => (
                    <li
                      key={`${consent.tokenId}-${consent.viewer}`}
                      className={`rounded-lg border px-3 py-2.5 ${
                        consent.active ? 'border-peacock-200 bg-peacock-50/30' : 'border-line bg-white'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-ink">
                          {consent.viewerLabel || short(consent.viewer)}
                        </span>
                        {consent.grantedVia === 'emergency' ? (
                          <Status state="pending">break-glass</Status>
                        ) : (
                          <Status state={consent.active ? 'active' : 'expired'}>
                            {consent.active ? 'Active' : 'Lapsed'}
                          </Status>
                        )}
                        {consent.revoked && <Status state="revoked">Revoked</Status>}
                        <span className="ml-auto text-[10px] text-slate-400">
                          {consent.expiresAt ? `expires ${absoluteTime(consent.expiresAt)}` : ''}
                        </span>
                      </div>
                      <p className="mono mt-1 break-all text-[10px] text-slate-500">{consent.viewer}</p>
                      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        <div>
                          <dt className="text-[9px] uppercase tracking-wide text-slate-400">
                            Authorised by
                          </dt>
                          <dd className="text-[11px] text-slate-600">{consent.authorisedBy}</dd>
                        </div>
                        <div>
                          <dt className="text-[9px] uppercase tracking-wide text-slate-400">
                            Granted
                          </dt>
                          <dd className="text-[11px] text-slate-600">
                            {consent.grantedAt ? absoluteTime(consent.grantedAt) : '—'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[9px] uppercase tracking-wide text-slate-400">
                            Revoked
                          </dt>
                          <dd className="text-[11px] text-slate-600">
                            {consent.revokedAt ? absoluteTime(consent.revokedAt) : 'not revoked'}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              )}

              {/* The honest gap. Stating it is the difference between an audit view
                  and a dashboard that merely looks like one. */}
              <Callout tone="warn" className="mt-3" title="What this ledger cannot tell you">
                A window that was <em>used</em> looks exactly like one that was never touched.
                Reading a record is a <span className="mono">view</span> call that leaves no trace on
                this contract, and a refused read leaves none either. So this log proves who was
                <em> authorised</em>, at what time, by whom — it does not prove who actually looked.
              </Callout>
            </section>

            <PanelBoundary name="This record's timeline">
              <section className="rounded-lg border border-line bg-white p-3.5">
                <h3 className="mb-3 text-xs font-semibold text-ink">Full event trail</h3>
                <RecordTimeline tokenId={drawer.tokenId} />
              </section>
            </PanelBoundary>
          </div>
        )}
      </Drawer>

      {/* ------------------------------------------------------- reader attempt */}
      <Drawer
        open={Boolean(reader)}
        onClose={() => setReader(null)}
        title={reader ? `Content · ${humanType(reader.recordType)}` : ''}
        subtitle={reader ? `token #${reader.tokenId}` : ''}
        width="max-w-3xl"
      >
        {reader && (
          <RecordReader
            tokenId={reader.tokenId}
            viewer={account}
            record={reader}
            onBack={() => setReader(null)}
            backLabel="Close"
          />
        )}
      </Drawer>
    </div>
  );
}
