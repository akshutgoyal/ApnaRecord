import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useChain } from '../../chain';
import { useStats, useProfiles } from '../../hooks/useDashboardData';
import { useTableState } from '../../hooks/useTableState';
import { DonutChart, AreaTrend, AccessBars, GaugeChart } from '../../components/viz/charts';
import LifecycleFlow from '../../components/viz/LifecycleFlow';
import ConsentTimer from '../../components/ConsentTimer';
import {
  ChartCard,
  DataTable,
  DonutLegend,
  EmptyPanel,
  OffChainBadge,
  ProgressBar,
  StatCard,
} from '../../components/viz/primitives';
import { Callout, Card, EmptyState, Pill, SkeletonCards, Status } from '../../components/ui';
import PanelBoundary from '../../components/PanelBoundary';
import Drawer from '../../components/Drawer';
import PatientChart from '../../components/PatientChart';
import RecordReader from '../../components/RecordReader';
import ExpiryWatchlist from '../../components/ExpiryWatchlist';
import { DashboardBar, ExportButton } from '../../components/DashboardBar';
import { humanType, shortAddress as short, relativeTime } from '../../lib/format';

const SOON_SECONDS = 24 * 60 * 60;

const STATE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'readable', label: 'Readable now' },
  { key: 'expired', label: 'Window lapsed' },
  { key: 'none', label: 'No consent' },
];

export default function DoctorDashboard() {
  const { account, roles } = useChain();
  const { stats, loading, error, lastUpdated, refreshing, refreshFromChain } = useStats();
  const { byAddress, nameFor } = useProfiles();

  const [drawer, setDrawer] = useState(null);
  const [reader, setReader] = useState(null);
  const [stateFilter, setStateFilter] = useState('all');

  // Which records this wallet may read right now, straight from the consent rows
  // the backend read out of the contract.
  const mine = useMemo(() => {
    if (!stats || !account) return { active: [], expired: [] };
    const lower = account.toLowerCase();
    const forMe = stats.consents.filter((c) => c.viewer.toLowerCase() === lower);
    return {
      active: forMe.filter((c) => c.active),
      expired: forMe.filter((c) => !c.active),
    };
  }, [stats, account]);

  const accessibleTokenIds = useMemo(
    () => new Set(mine.active.map((c) => c.tokenId)),
    [mine.active]
  );

  const accessibleRecords = useMemo(
    () => (stats ? stats.records.filter((r) => accessibleTokenIds.has(r.tokenId)) : []),
    [stats, accessibleTokenIds]
  );

  const now = Math.floor(Date.now() / 1000);
  const closingSoon = mine.active
    .filter((c) => c.expiresAt && c.expiresAt - now <= SOON_SECONDS)
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .map((c) => ({
      ...c,
      viewer: c.viewer,
      viewerLabel: 'You',
    }));

  const patientRows = useMemo(() => {
    if (!stats) return [];
    return stats.patients
      .filter((p) => p.records > 0 || p.roles.manager)
      .map((patient) => {
        const theirRecords = stats.records.filter((r) => r.patient === patient.address);
        const readable = theirRecords.filter((r) => accessibleTokenIds.has(r.tokenId));
        const expired = mine.expired.filter((c) => theirRecords.some((r) => r.tokenId === c.tokenId));
        return {
          ...patient,
          recordCount: theirRecords.length,
          readableCount: readable.length,
          expiredCount: expired.length,
          expiresAt: mine.active.find((c) => theirRecords.some((r) => r.tokenId === c.tokenId))
            ?.expiresAt,
          state:
            readable.length > 0
              ? 'readable'
              : expired.length > 0
                ? 'expired'
                : theirRecords.length > 0
                  ? 'none'
                  : 'no-records',
        };
      })
      .sort((a, b) => b.readableCount - a.readableCount || b.recordCount - a.recordCount);
  }, [stats, mine.expired, mine.active, accessibleTokenIds]);

  const table = useTableState({
    rows: patientRows,
    searchFields: ['address', 'label', 'displayName'],
    initialSort: { key: 'readable', dir: 'desc' },
    pageSize: 10,
    sorters: {
      name: (row) => row.displayName || row.label || row.address,
      readable: (row) => row.readableCount,
      records: (row) => row.recordCount,
    },
  });

  const filteredPatients = useMemo(() => {
    const base = table.sorted;
    if (stateFilter === 'all') return base;
    return base.filter((row) => row.state === stateFilter);
  }, [table.sorted, stateFilter]);

  const patientsWithRecords = (stats?.patients ?? []).filter((patient) => patient.records > 0);

  const pagedPatients = filteredPatients.slice(
    (table.page - 1) * table.pageSize,
    table.page * table.pageSize
  );

  // A patient row from the stats payload, or a minimal shape so the chart can
  // render for a wallet the identity index does not know about.
  const patientRowFor = (patient) => ({
    address: patient.address,
    label: patient.label || null,
    displayName: patient.displayName || null,
    roles: patient.roles || { admin: false, manager: false, auditor: false },
    active: patient.active !== false,
    records: patient.records || 0,
    consentsActive: patient.consentsActive || 0,
  });

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

  const coverage = stats.totals.records > 0 ? accessibleRecords.length / stats.totals.records : 0;

  const accessSplit = [
    { name: 'Readable now', value: accessibleRecords.length },
    {
      name: 'No active consent',
      value: Math.max(0, stats.totals.records - accessibleRecords.length),
    },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-peacock-700">
            Clinician · Manager role
          </p>
          <h1 className="font-display mt-1 text-2xl font-bold tracking-tight text-ink">
            Clinical workspace
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
            Every record below is filtered by what the contract says you may read. No permission here
            is cached — each row was checked against{' '}
            <span className="mono text-xs">canAccess</span> as this wallet.
          </p>
        </div>
        {roles.manager ? (
          <Status state="active">MANAGER_ROLE</Status>
        ) : (
          <Status state="denied">No manager role</Status>
        )}
      </header>

      {!roles.manager && (
        <Callout tone="warn" title="This wallet does not hold MANAGER_ROLE">
          Requesting records will revert. That is the contract refusing, not the interface.
        </Callout>
      )}

      <DashboardBar
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={refreshFromChain}
        stats={stats}
      >
        <ExportButton
          filename="apnarecord-my-patients"
          label="Export patients"
          rows={filteredPatients}
          columns={[
            { key: 'label', label: 'On-chain label' },
            { key: 'displayName', label: 'Display name' },
            { key: 'address', label: 'Wallet' },
            { key: 'recordCount', label: 'Records' },
            { key: 'readableCount', label: 'Readable by me' },
            { key: 'expiredCount', label: 'Lapsed windows' },
            { key: 'state', label: 'Access state' },
          ]}
        />
      </DashboardBar>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Readable now"
          value={accessibleRecords.length}
          tone="success"
          hint={`of ${stats.totals.records} records on the contract`}
        />
        <StatCard
          label="Patients with records"
          value={patientRows.filter((r) => r.recordCount > 0).length}
          tone="peacock"
          hint={`${patientRows.filter((r) => r.readableCount > 0).length} have a live window for you`}
        />
        <StatCard
          label="Closing within 24h"
          value={closingSoon.length}
          tone={closingSoon.length > 0 ? 'marigold' : 'default'}
          hint={
            closingSoon.length > 0
              ? 'Your reads about to lapse — listed below'
              : 'Nothing of yours lapses today'
          }
        />
        <StatCard
          label="Lapsed windows"
          value={mine.expired.length}
          tone="default"
          hint="Closed themselves — nothing to revoke"
          stale={Boolean(stats.stale)}
        />
      </div>

      <PanelBoundary name="Your expiry watchlist">
        <ExpiryWatchlist
          items={closingSoon}
          title="Your access, closing within 24 hours"
          note="A patient can extend any of these"
        />
      </PanelBoundary>

      <div className="grid gap-4 lg:grid-cols-3">
        <PanelBoundary name="My access right now">
          <ChartCard
            title="My access right now"
            subtitle="Readable out of everything minted"
            right={
              <div className="w-36">
                <DonutLegend data={accessSplit} />
              </div>
            }
          >
            <DonutChart
              data={accessSplit}
              centerValue={accessibleRecords.length}
              centerLabel={`of ${stats.totals.records} readable`}
            />
          </ChartCard>
        </PanelBoundary>

        <PanelBoundary name="Per-patient access">
          <ChartCard title="Per-patient access" subtitle="Readable against not-yet-authorised">
            <AccessBars
              data={patientRows
                .filter((row) => row.recordCount > 0)
                .slice(0, 8)
                .map((row) => ({
                  name: row.displayName || row.label || short(row.address),
                  readable: row.readableCount,
                  locked: Math.max(0, row.recordCount - row.readableCount),
                }))}
            />
          </ChartCard>
        </PanelBoundary>

        <PanelBoundary name="Access coverage">
          <ChartCard title="Access coverage" subtitle="Share of the contract you can currently read">
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                <GaugeChart
                  value={accessibleRecords.length}
                  max={Math.max(stats.totals.records, 1)}
                  label="of all records"
                />
              </div>
              <div className="px-3 pb-1">
                <ProgressBar
                  value={Math.round(coverage * 100)}
                  label="Readable vs minted"
                  sublabel={`${accessibleRecords.length} / ${stats.totals.records}`}
                />
              </div>
            </div>
          </ChartCard>
        </PanelBoundary>
      </div>

      <PanelBoundary name="Contract activity">
        <ChartCard
          title="Contract activity"
          subtitle="When records and consent windows moved"
          height={220}
        >
          <AreaTrend data={stats.activityByDay} label="events" />
        </ChartCard>
      </PanelBoundary>

      <Card
        title="Patients and access"
        subtitle="Names come from patient-owned off-chain profiles; access comes from the contract. Click a row for detail."
        right={<Pill tone="slate">{filteredPatients.length} shown</Pill>}
      >
        <PanelBoundary name="The patient table">
          <DataTable
            freezeFirstColumn
            rowKey={(row) => row.address}
            rows={pagedPatients}
            total={filteredPatients.length}
            filtered={table.isFiltered || stateFilter !== 'all'}
            empty="No patients with records yet"
            emptyFiltered="No patient matches these filters."
            onRowClick={(row) => setDrawer(row)}
            sort={table.sort}
            onToggleSort={table.toggleSort}
            page={table.page}
            pageSize={table.pageSize}
            totalPages={Math.max(1, Math.ceil(filteredPatients.length / table.pageSize))}
            onPageChange={table.setPage}
            onPageSizeChange={table.setPageSize}
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input h-9 w-48 py-0 text-xs"
                  value={table.query}
                  onChange={(event) => table.setQuery(event.target.value)}
                  placeholder="Search patient…"
                  aria-label="Search patients"
                />
                <div className="flex flex-wrap gap-1">
                  {STATE_FILTERS.map((chip) => (
                    <button
                      key={chip.key}
                      type="button"
                      aria-pressed={stateFilter === chip.key}
                      onClick={() => {
                        setStateFilter(chip.key);
                        table.setPage(1);
                      }}
                      className={`rounded-institutional border px-2.5 py-1 text-[11px] font-medium transition ${
                        stateFilter === chip.key
                          ? 'border-peacock-300 bg-peacock-50 text-peacock-700'
                          : 'border-line bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            }
            columns={[
              {
                key: 'name',
                label: 'Patient',
                render: (row) => {
                  const name = row.displayName || nameFor(row.address, row.label) || 'Unnamed';
                  return (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-ink">{name}</span>
                      {row.displayName ? (
                        <OffChainBadge />
                      ) : (
                        <span className="text-[10px] text-slate-400">No profile set</span>
                      )}
                      <span className="mono text-[10px] text-slate-400">{short(row.address)}</span>
                    </div>
                  );
                },
              },
              {
                key: 'records',
                label: 'Records',
                align: 'right',
                render: (row) => (
                  <span className="tabular-nums">
                    {row.readableCount} / {row.recordCount}
                  </span>
                ),
              },
              {
                // The token numbers, visible without opening anything. A clinician
                // who has to click into every patient to find out which scan is
                // token 3 will not do it, and will work from memory instead.
                key: 'tokens',
                label: 'Tokens held',
                sortable: false,
                render: (row) => {
                  const tokens = stats.records.filter((r) => r.patient === row.address);
                  if (tokens.length === 0) return <span className="text-slate-400">—</span>;
                  return (
                    <div className="flex flex-wrap gap-1">
                      {tokens.map((record) => {
                        const canOpen = accessibleTokenIds.has(record.tokenId);
                        return (
                          <button
                            key={record.tokenId}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              // Readable: go straight to the report, which is why a
                              // clinician is here. Not readable: open the chart, which
                              // says why and what to do about it.
                              if (canOpen) setReader(record);
                              else setDrawer(row);
                            }}
                            title={
                              canOpen
                                ? `Open ${humanType(record.recordType)} (token #${record.tokenId})`
                                : `${humanType(record.recordType)} (token #${record.tokenId}) — no consent; opens the chart`
                            }
                            className={`rounded-institutional border px-1.5 py-0.5 text-[10px] font-medium tabular-nums transition ${
                              canOpen
                                ? 'border-peacock-200 bg-peacock-50 text-peacock-700 hover:bg-peacock-100'
                                : 'border-line bg-slate-50 text-slate-500 hover:bg-slate-100'
                            }`}
                          >
                            #{record.tokenId}
                          </button>
                        );
                      })}
                    </div>
                  );
                },
              },
              {
                key: 'state',
                label: 'Access state',
                align: 'center',
                sortable: false,
                render: (row) => {
                  if (row.state === 'readable') return <Status state="active">Readable now</Status>;
                  if (row.state === 'expired') return <Status state="expired">Window expired</Status>;
                  if (row.state === 'none') return <Status state="pending">No consent</Status>;
                  return <span className="text-slate-400">—</span>;
                },
              },
              {
                key: 'expiresAt',
                label: 'Window',
                sortable: false,
                render: (row) =>
                  row.state === 'readable' ? (
                    <ConsentTimer expiresAt={row.expiresAt} showAbsolute={false} label="Ends" />
                  ) : (
                    <span className="text-[11px] text-slate-400">—</span>
                  ),
              },
              {
                key: 'open',
                label: '',
                align: 'right',
                sortable: false,
                render: () => <span className="text-[11px] text-slate-400">Details →</span>,
              },
            ]}
          />
        </PanelBoundary>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Records you may read now"
          subtitle="Confirmed by the contract, with the window that permits it"
        >
          {accessibleRecords.length === 0 ? (
            <div className="py-2">
              <EmptyState
                variant="blocked"
                title="You hold no live consent on any record"
                hint="Only the record owner can change that. A clinician cannot grant themselves access, an administrator cannot grant it on the patient's behalf, and we have no override — the contract is the only thing that decides."
              />
              {patientsWithRecords.length > 0 && (
                <>
                  <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Patients holding records who have not opened a window to you
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {patientsWithRecords
                      .filter((patient) => !patientRows.find((row) => row.address === patient.address)?.readableCount)
                      .map((patient) => (
                        <li
                          key={patient.address}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white px-3 py-2"
                        >
                          <span className="text-xs font-medium text-ink">
                            {patient.displayName || patient.label || short(patient.address)}
                          </span>
                          {mine.expired.some(
                            (consent) =>
                              String(consent.patient).toLowerCase() === patient.address.toLowerCase()
                          ) && <Status state="expired">had access · now lapsed</Status>}
                          <div className="ml-auto flex flex-wrap gap-1">
                            {stats.records
                              .filter((record) => record.patient === patient.address)
                              .map((record) => (
                                <Pill key={record.tokenId} tone="slate">
                                  #{record.tokenId}
                                </Pill>
                              ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => setDrawer(patientRowFor(patient))}
                            className="btn-secondary text-xs"
                          >
                            Chart
                          </button>
                        </li>
                      ))}
                  </ul>
                </>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {accessibleRecords.map((record) => {
                const consent = mine.active.find((c) => c.tokenId === record.tokenId);
                const patient = stats.patients.find((p) => p.address === record.patient);
                return (
                  <li key={record.tokenId} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone="peacock">#{record.tokenId}</Pill>
                      <span className="text-xs font-medium text-ink">
                        {humanType(record.recordType)}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {patient?.displayName || record.patientLabel || short(record.patient)}
                      </span>
                      <span className="ml-auto">
                        <ConsentTimer expiresAt={consent?.expiresAt} showAbsolute={false} label="Ends" />
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Issued {record.mintedAt ? relativeTime(record.mintedAt) : `in block ${record.mintedAtBlock}`}
                      {record.orderedByLabel ? ` · ordered by ${record.orderedByLabel}` : ''}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setReader(record)}
                        className="btn-primary text-xs"
                      >
                        Open report
                      </button>
                      <button
                        type="button"
                        onClick={() => setDrawer(patient || { address: record.patient })}
                        className="btn-secondary text-xs"
                      >
                        Patient chart
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3">
            <Link to="/doctor/console" className="btn-secondary w-full">
              Open the records console
            </Link>
          </div>
        </Card>

        <Card title="Clinical actions" subtitle="Both are recorded on-chain and both are gated">
          <div className="space-y-3">
            <div className="rounded-lg border border-line p-3">
              <p className="text-xs font-semibold text-ink">Request a record</p>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
                Emits <span className="mono">RecordRequested</span>. The admin decides whether to mint
                — a clinician requesting is not a clinician minting.
              </p>
              <Link to="/doctor/console" className="btn-secondary mt-2 w-full">
                requestRecord
              </Link>
            </div>
            <div className="rounded-lg border border-warn-200 bg-warn-50 p-3">
              <p className="text-xs font-semibold text-ink">Emergency break-glass</p>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
                Bypasses consent by design. One hour, one record, and the stated reason is permanent.
              </p>
              <Link
                to="/doctor/console"
                className="btn-secondary mt-2 w-full border-warn-200 text-warn-700 hover:bg-warn-50"
              >
                emergencyAccess
              </Link>
            </div>
          </div>
        </Card>
      </div>

      <Card title="Record lifecycle" subtitle="You act at steps 2 and 5; the contract decides at 4 and 6">
        <LifecycleFlow role="doctor" />
      </Card>

      {/* ------------------------------------------------------------ drawer */}
      <Drawer
        open={Boolean(drawer)}
        onClose={() => setDrawer(null)}
        title={drawer?.displayName || drawer?.label || 'Patient'}
        subtitle={drawer ? short(drawer.address) : ''}
        footer={
          <div className="flex flex-wrap gap-2">
            <Link to="/doctor/console" className="btn-primary">
              Open the records console
            </Link>
          </div>
        }
      >
        {drawer && (
          <PatientChart
            patient={drawer}
            stats={stats}
            profile={drawer.address ? byAddress[String(drawer.address).toLowerCase()] : null}
            viewer={account}
            nameFor={nameFor}
          />
        )}
      </Drawer>

      {/* ------------------------------------------------------- report reader */}
      <Drawer
        open={Boolean(reader)}
        onClose={() => setReader(null)}
        title={reader ? `Report · ${humanType(reader.recordType)}` : ''}
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
