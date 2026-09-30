import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useChain } from '../../chain';
import { useStats, useProfiles } from '../../hooks/useDashboardData';
import { useTableState } from '../../hooks/useTableState';
import { TX_EXPLORER } from '../../contract';
import { DonutChart, AreaTrend, BarsChart } from '../../components/viz/charts';
import ConsentTimer from '../../components/ConsentTimer';
import LifecycleFlow from '../../components/viz/LifecycleFlow';
import {
  ChartCard,
  DataTable,
  DonutLegend,
  EmptyPanel,
  ProgressBar,
  StatCard,
} from '../../components/viz/primitives';
import { Callout, Card, Pill, SkeletonCards, Status } from '../../components/ui';
import PanelBoundary from '../../components/PanelBoundary';
import Drawer from '../../components/Drawer';
import RecordTimeline from '../../components/RecordTimeline';
import ExpiryWatchlist from '../../components/ExpiryWatchlist';
import { DashboardBar, ExportButton } from '../../components/DashboardBar';
import { humanType, shortAddress as short } from '../../lib/format';

const SOON_SECONDS = 24 * 60 * 60;

export default function PatientDashboard() {
  const { account, ownedRecords } = useChain();
  const { stats, loading, error, lastUpdated, refreshing, refreshFromChain } = useStats();
  const { byAddress, nameFor } = useProfiles();

  const [drawer, setDrawer] = useState(null);
  const [readerFilter, setReaderFilter] = useState('all');

  const myTokenIds = useMemo(
    () => new Set(ownedRecords.map((record) => record.tokenId)),
    [ownedRecords]
  );

  const myRecords = useMemo(
    () => (stats ? stats.records.filter((record) => myTokenIds.has(record.tokenId)) : []),
    [stats, myTokenIds]
  );

  const consents = useMemo(() => {
    if (!stats) return [];
    return stats.consents
      .filter((consent) => myTokenIds.has(consent.tokenId))
      .map((consent) => ({
        ...consent,
        readerName:
          nameFor(consent.viewer, consent.viewerLabel) || consent.viewerLabel || short(consent.viewer),
      }));
  }, [stats, myTokenIds, nameFor]);

  const activeConsents = consents.filter((row) => row.active);
  const lapsedConsents = consents.filter((row) => !row.active);

  const now = Math.floor(Date.now() / 1000);
  const closingSoon = activeConsents
    .filter((c) => c.expiresAt && c.expiresAt - now <= SOON_SECONDS)
    .sort((a, b) => a.expiresAt - b.expiresAt);

  const myEvents = useMemo(() => {
    if (!stats) return [];
    return stats.recentEvents.filter((event) => {
      const args = event.args || {};
      if (args.tokenId !== undefined) return myTokenIds.has(Number(args.tokenId));
      return String(args.patient || '').toLowerCase() === String(account || '').toLowerCase();
    });
  }, [stats, myTokenIds, account]);

  const table = useTableState({
    rows: myRecords,
    searchFields: ['recordType', 'recordHash'],
    initialSort: { key: 'tokenId', dir: 'desc' },
    pageSize: 10,
    sorters: {
      readers: (row) => row.consentsActive,
      type: (row) => humanType(row.recordType),
    },
  });

  const filteredRecords = useMemo(() => {
    const base = table.sorted;
    if (readerFilter === 'all') return base;
    if (readerFilter === 'shared') return base.filter((row) => row.consentsActive > 0);
    return base.filter((row) => row.consentsActive === 0);
  }, [table.sorted, readerFilter]);

  const pagedRecords = filteredRecords.slice(
    (table.page - 1) * table.pageSize,
    table.page * table.pageSize
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

  const profile = account ? byAddress[account.toLowerCase()] : null;
  const profileFields = [
    profile?.displayName,
    profile?.dateOfBirth,
    profile?.bloodGroup,
    profile?.allergies,
    profile?.emergencyContact,
  ].filter(Boolean).length;

  const types = Object.entries(
    myRecords.reduce((acc, record) => {
      acc[record.recordType] = (acc[record.recordType] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, value]) => ({ name: humanType(name), value }));

  // Access per reader: 1 for active, 0 for lapsed — a bar chart of "who can see
  // what right now" rather than a count of historical grants.
  const readers = activeConsents.map((consent) => ({
    name: consent.readerName,
    value: 1,
  }));

  const exportColumns = [
    { key: 'tokenId', label: 'Token' },
    { key: 'recordType', label: 'Type' },
    { key: 'recordHash', label: 'Digest' },
    { key: 'mintedAtBlock', label: 'Minted block' },
    { key: 'mintedTx', label: 'Mint transaction' },
    { key: 'consentsActive', label: 'Readers now' },
    { key: 'consentsTotal', label: 'Windows ever granted' },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-peacock-700">
            Patient · record owner
          </p>
          <h1 className="font-display mt-1 text-2xl font-bold tracking-tight text-ink">
            {profile?.displayName ? `Hello, ${profile.displayName}` : 'Your health records'}
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
            These records are yours. The hospital minted them but cannot move them, read them, or open
            them to anyone without your say-so — and every access is on the record, permanently.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/patient/profile" className="btn-secondary">
            {profile ? 'Edit my profile' : 'Add my details'}
          </Link>
          <Link to="/patient/console" className="btn-primary">
            Manage access
          </Link>
        </div>
      </header>

      {activeConsents.length > 0 && (
        <Callout tone="accent" title={`${activeConsents.length} wallets can read your records right now`}>
          That is because you allowed it. You can close any of these windows immediately from the
          console, and the contract will refuse their next read the moment it lands.
        </Callout>
      )}

      <DashboardBar
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={refreshFromChain}
        stats={stats}
      >
        <ExportButton
          filename="apnarecord-my-records"
          label="Export my records"
          rows={myRecords}
          columns={exportColumns}
        />
      </DashboardBar>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Records you own"
          value={myRecords.length}
          tone="peacock"
          hint="Soulbound — nobody can transfer them"
        />
        <StatCard
          label="Readers with access"
          value={activeConsents.length}
          tone={activeConsents.length > 0 ? 'marigold' : 'success'}
          hint={`${lapsedConsents.length} window${lapsedConsents.length === 1 ? '' : 's'} lapsed`}
        />
        <StatCard
          label="Closing within 24h"
          value={closingSoon.length}
          tone={closingSoon.length > 0 ? 'marigold' : 'default'}
          hint={
            closingSoon.length > 0
              ? 'Access ending soon — listed below'
              : 'Nothing of yours is ending today'
          }
        />
        <StatCard
          label="Events on your records"
          value={myEvents.length}
          tone="ink"
          hint="Public and permanent"
          stale={Boolean(stats.stale)}
        />
      </div>

      <PanelBoundary name="Your expiry watchlist">
        <ExpiryWatchlist
          items={closingSoon}
          title="Access to your records, ending within 24 hours"
          note="You can revoke or extend any of these"
        />
      </PanelBoundary>

      <div className="grid gap-4 lg:grid-cols-3">
        <PanelBoundary name="Your records by type">
          <ChartCard
            title="Your records by type"
            subtitle="What the hospital has issued to you"
            right={
              types.length > 0 ? (
                <div className="w-32">
                  <DonutLegend data={types} />
                </div>
              ) : null
            }
          >
            <DonutChart data={types} centerLabel="records" />
          </ChartCard>
        </PanelBoundary>

        <PanelBoundary name="Who you have shared with">
          <ChartCard
            title="Who you have shared with"
            subtitle="Active windows only — a lapsed grant is not access"
          >
            {readers.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6">
                <p className="text-center text-xs leading-relaxed text-slate-400">
                  Nobody can read your records right now. That is the default.
                </p>
              </div>
            ) : (
              <BarsChart data={readers} horizontal />
            )}
          </ChartCard>
        </PanelBoundary>

        <PanelBoundary name="Your profile">
          <Card title="Your profile" subtitle="The only personal data we hold — and it is off-chain">
            <ProgressBar
              value={profileFields}
              max={5}
              tone={profileFields >= 3 ? 'peacock' : 'marigold'}
              label="Fields completed"
              sublabel={`${profileFields} / 5`}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              The chain never learns your name. Whatever you put here is signed by your wallet,
              editable only by you, and deletable at any time.
            </p>
            <div className="mt-3">
              <Link to="/patient/profile" className="btn-secondary w-full">
                {profile ? 'Edit my details' : 'Add my details'}
              </Link>
            </div>
          </Card>
        </PanelBoundary>
      </div>

      <PanelBoundary name="Contract activity">
        <ChartCard
          title="Contract activity"
          subtitle={`Every event on this contract. ${myEvents.length} of them concern your records.`}
          height={220}
        >
          <AreaTrend data={stats.activityByDay} label="events" />
        </ChartCard>
      </PanelBoundary>

      <Card
        title="Your records"
        subtitle="Ownership read from ownerOf() on the contract. Click a row to see its full history."
        right={<Pill tone="peacock">{filteredRecords.length} shown</Pill>}
      >
        <PanelBoundary name="Your records table">
          <DataTable
            freezeFirstColumn
            rowKey={(row) => row.tokenId}
            rows={pagedRecords}
            total={filteredRecords.length}
            filtered={table.isFiltered || readerFilter !== 'all'}
            empty="You do not own any records yet"
            emptyFiltered="No record matches these filters."
            onRowClick={(row) => setDrawer(row)}
            sort={table.sort}
            onToggleSort={table.toggleSort}
            page={table.page}
            pageSize={table.pageSize}
            totalPages={Math.max(1, Math.ceil(filteredRecords.length / table.pageSize))}
            onPageChange={table.setPage}
            onPageSizeChange={table.setPageSize}
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input h-9 w-44 py-0 text-xs"
                  value={table.query}
                  onChange={(event) => table.setQuery(event.target.value)}
                  placeholder="Search my records…"
                  aria-label="Search my records"
                />
                <div className="flex flex-wrap gap-1">
                  {[
                    { key: 'all', label: 'All' },
                    { key: 'shared', label: 'Shared' },
                    { key: 'private', label: 'Only me' },
                  ].map((chip) => (
                    <button
                      key={chip.key}
                      type="button"
                      aria-pressed={readerFilter === chip.key}
                      onClick={() => {
                        setReaderFilter(chip.key);
                        table.setPage(1);
                      }}
                      className={`rounded-institutional border px-2.5 py-1 text-[11px] font-medium transition ${
                        readerFilter === chip.key
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
                key: 'tokenId',
                label: 'Token',
                render: (row) => <Pill tone="peacock">#{row.tokenId}</Pill>,
              },
              {
                key: 'type',
                label: 'Type',
                render: (row) => humanType(row.recordType),
              },
              {
                key: 'locked',
                label: 'Transferable',
                align: 'center',
                sortable: false,
                render: () => <Status state="expired">No — soulbound</Status>,
              },
              {
                key: 'readers',
                label: 'Who can read it',
                align: 'right',
                render: (row) =>
                  row.consentsActive === 0 ? (
                    <span className="text-slate-400">only you</span>
                  ) : (
                    <span className="font-medium tabular-nums text-marigold-700">
                      {row.consentsActive} wallet{row.consentsActive === 1 ? '' : 's'}
                    </span>
                  ),
              },
              { key: 'mintedAtBlock', label: 'Minted in block', align: 'right' },
              {
                key: 'open',
                label: '',
                align: 'right',
                sortable: false,
                render: () => <span className="text-[11px] text-slate-400">History →</span>,
              },
            ]}
          />
        </PanelBoundary>
      </Card>

      <Card
        title="Consent windows on your records"
        subtitle="Read from the contract, not from our notes"
        right={
          <div className="flex items-center gap-2">
            {activeConsents.length > 0 && <Status state="active">{activeConsents.length} active</Status>}
            {lapsedConsents.length > 0 && <Status state="expired">{lapsedConsents.length} lapsed</Status>}
          </div>
        }
      >
        {consents.length === 0 ? (
          <p className="py-6 text-center text-xs leading-relaxed text-slate-500">
            Nobody has ever been granted access. That is the default state — consent is something you
            give, not something you withdraw.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {consents.map((row) => (
              <li
                key={`${row.tokenId}-${row.viewer}`}
                className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5 ${
                  row.active ? 'border-peacock-200 bg-peacock-50/40' : 'border-line'
                }`}
              >
                <span className="text-xs font-medium text-ink">{row.readerName}</span>
                <Pill tone="slate">#{row.tokenId}</Pill>
                <span className="text-[11px] text-slate-500">{humanType(row.recordType)}</span>
                <span className="ml-auto">
                  <ConsentTimer expiresAt={row.active ? row.expiresAt : undefined} showAbsolute={false} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <Link to="/patient/console" className="btn-secondary w-full">
            Open the Patient console
          </Link>
        </div>
      </Card>

      <Card title="How your record moves" subtitle="You control steps 5 and 6">
        <LifecycleFlow compact />
      </Card>

      {/* ------------------------------------------------------------ drawer */}
      <Drawer
        open={Boolean(drawer)}
        onClose={() => setDrawer(null)}
        title={drawer ? `Record #${drawer.tokenId} · ${humanType(drawer.recordType)}` : ''}
        subtitle={drawer ? `owned by you · minted in block ${drawer.mintedAtBlock}` : ''}
        footer={
          <div className="flex flex-wrap gap-2">
            <Link to="/patient/console" className="btn-primary">
              Manage access to this record
            </Link>
            <Link to="/verify" className="btn-secondary">
              Verify this record
            </Link>
          </div>
        }
      >
        {drawer && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Pill tone="peacock">#{drawer.tokenId}</Pill>
              {drawer.locked && <Status state="expired">soulbound · cannot be transferred</Status>}
              {drawer.burned && <Status state="revoked">burned</Status>}
              {drawer.consentsActive === 0 ? (
                <Status state="active">Only you can read it</Status>
              ) : (
                <Status state="pending">{drawer.consentsActive} readers</Status>
              )}
            </div>

            <section className="space-y-3 rounded-lg border border-line bg-white p-3.5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Digest anchored on-chain
                </p>
                <p className="mono mt-1 break-all text-slate-700">{drawer.recordHash}</p>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  This is keccak256 of the encrypted file. Anyone holding the file can recompute it and
                  check it against this value — that is what{' '}
                  <Link to="/verify" className="text-peacock-700 underline">
                    the verifier
                  </Link>{' '}
                  does.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Minted in block
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-slate-700">{drawer.mintedAtBlock}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Windows ever granted
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-slate-700">{drawer.consentsTotal}</p>
                </div>
              </div>
              <a
                href={`${TX_EXPLORER}${drawer.mintedTx}`}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-[11px] text-peacock-700 underline decoration-dotted underline-offset-2"
              >
                View the mint transaction ↗
              </a>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold text-ink">Who can read this record</h3>
              {consents.filter((c) => c.tokenId === drawer.tokenId).length === 0 ? (
                <p className="text-[11px] text-slate-500">
                  Nobody but you. Ownership is not a consent window — you never need permission to read
                  your own record.
                </p>
              ) : (
                <ul className="space-y-2">
                  {consents
                    .filter((c) => c.tokenId === drawer.tokenId)
                    .map((consent) => (
                      <li
                        key={`${consent.tokenId}-${consent.viewer}`}
                        className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${
                          consent.active ? 'border-peacock-200 bg-peacock-50/40' : 'border-line bg-white'
                        }`}
                      >
                        <span className="text-xs font-medium text-ink">{consent.readerName}</span>
                        <span className="mono text-[10px] text-slate-400">{short(consent.viewer)}</span>
                        <span className="ml-auto">
                          <ConsentTimer
                            expiresAt={consent.active ? consent.expiresAt : undefined}
                            showAbsolute={false}
                          />
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </section>

            <PanelBoundary name="This record's timeline">
              <section className="rounded-lg border border-line bg-white p-3.5">
                <h3 className="mb-3 text-xs font-semibold text-ink">Full history</h3>
                <RecordTimeline tokenId={drawer.tokenId} />
              </section>
            </PanelBoundary>
          </div>
        )}
      </Drawer>
    </div>
  );
}
