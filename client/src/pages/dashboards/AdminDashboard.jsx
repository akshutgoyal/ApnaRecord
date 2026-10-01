import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useChain } from '../../chain';
import { useStats, useProfiles } from '../../hooks/useDashboardData';
import { useTableState } from '../../hooks/useTableState';
import { CONTRACT_ADDRESS, EXPLORER, TX_EXPLORER } from '../../contract';
import { DonutChart, BarsChart, AreaTrend, GaugeChart } from '../../components/viz/charts';
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
import { Callout, Card, Pill, SkeletonCards, Status } from '../../components/ui';
import PanelBoundary from '../../components/PanelBoundary';
import Drawer from '../../components/Drawer';
import PatientChart from '../../components/PatientChart';
import RecordReader from '../../components/RecordReader';
import RecordTimeline from '../../components/RecordTimeline';
import ExpiryWatchlist from '../../components/ExpiryWatchlist';
import ConsentTimer from '../../components/ConsentTimer';
import { DashboardBar, ExportButton } from '../../components/DashboardBar';
import { humanType, shortAddress as short, absoluteTime, relativeTime } from '../../lib/format';

const QUICK_ACTIONS = [
  {
    to: '/admin/console',
    title: 'Mint a record',
    detail: 'Encrypt a file in the browser, anchor its digest, and assign the token to the patient.',
    gate: 'DEFAULT_ADMIN_ROLE',
  },
  {
    to: '/admin/console',
    title: 'Register an identity',
    detail: 'Create an on-chain identity for a new wallet. The event is the audit record.',
    gate: 'DEFAULT_ADMIN_ROLE',
  },
  {
    to: '/admin/console',
    title: 'Grant a role',
    detail: 'MANAGER_ROLE for clinicians and labs, AUDITOR_ROLE for compliance.',
    gate: 'DEFAULT_ADMIN_ROLE',
  },
  {
    to: '/admin/console',
    title: 'Revoke a record',
    detail: 'Burn a token when a wallet is lost. Irreversible, and recorded forever.',
    gate: 'DEFAULT_ADMIN_ROLE',
  },
];

const ROLE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'admin', label: 'Admin' },
  { key: 'manager', label: 'Manager' },
  { key: 'auditor', label: 'Auditor' },
  { key: 'unassigned', label: 'Unassigned' },
];

export default function AdminDashboard() {
  const { account, roles } = useChain();
  const { stats, loading, error, lastUpdated, refreshing, refreshFromChain } = useStats();
  const { byAddress, nameFor } = useProfiles();

  const [drawer, setDrawer] = useState(null);
  const [reader, setReader] = useState(null);
  const [roleFilter, setRoleFilter] = useState('all');
  const [recordTypeFilter, setRecordTypeFilter] = useState('all');

  const patients = stats?.patients ?? [];
  const records = stats?.records ?? [];

  const identityTable = useTableState({
    rows: patients,
    searchFields: ['address', 'label', 'displayName'],
    initialSort: { key: 'records', dir: 'desc' },
    pageSize: 10,
    sorters: {
      name: (row) => row.displayName || row.label || row.address,
      records: (row) => row.records,
      consentsActive: (row) => row.consentsActive,
    },
  });

  const recordTable = useTableState({
    rows: records,
    searchFields: ['recordHash', 'recordType', 'patient', 'patientName', 'patientLabel'],
    initialSort: { key: 'tokenId', dir: 'desc' },
    pageSize: 10,
    sorters: {
      owner: (row) => row.patientName || row.patientLabel || row.patient,
      readers: (row) => row.consentsActive,
    },
  });

  // The role chip is a predicate over three booleans rather than a column value,
  // so it is applied after the generic filter/sort and paginated by hand.
  const identityRows = useMemo(() => {
    const base = identityTable.sorted;
    if (roleFilter === 'all') return base;
    if (roleFilter === 'unassigned') {
      return base.filter((row) => !row.roles.admin && !row.roles.manager && !row.roles.auditor);
    }
    return base.filter((row) => row.roles[roleFilter]);
  }, [identityTable.sorted, roleFilter]);

  const recordRows = useMemo(() => {
    const base = recordTable.sorted;
    if (recordTypeFilter === 'all') return base;
    return base.filter((row) => row.recordType === recordTypeFilter);
  }, [recordTable.sorted, recordTypeFilter]);

  const pagedIdentities = identityRows.slice(
    (identityTable.page - 1) * identityTable.pageSize,
    identityTable.page * identityTable.pageSize
  );
  const pagedRecords = recordRows.slice(
    (recordTable.page - 1) * recordTable.pageSize,
    recordTable.page * recordTable.pageSize
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

  if (error && !stats) {
    return (
      <EmptyPanel
        title="Could not read dashboard data"
        hint={`${error}. The backend reads chain state directly, so this is usually the API or the RPC endpoint.`}
      />
    );
  }

  const totals = stats.totals;
  const expiringSoon = stats.expiringSoon ?? [];
  const rolesAssigned = stats.identitiesByRole
    .filter((entry) => entry.name !== 'Unassigned')
    .reduce((sum, entry) => sum + entry.value, 0);
  const consentTotal = totals.activeConsents + totals.expiredConsents;
  const consentHealth =
    consentTotal > 0 ? Math.round((totals.activeConsents / consentTotal) * 100) : 100;

  const consentsFor = (tokenId) => stats.consents.filter((c) => c.tokenId === tokenId);

  // Requests a clinician has made that this contract has no record of answering.
  // Derived, because the contract keeps no request state — see the note on the card.
  const openRequests = (stats.requests || []).filter((request) => request.status === 'open');

  // A request can name a patient who has no identity row yet, so fall back to a
  // shape the chart can render rather than crashing on it.
  const patientRowFor = (address) =>
    stats.patients.find((p) => p.address === address) || {
      address,
      label: null,
      displayName: null,
      roles: { admin: false, manager: false, auditor: false },
      active: true,
      records: 0,
      consentsActive: 0,
    };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-peacock-700">
            Hospital IT · Admin
          </p>
          <h1 className="font-display mt-1 text-2xl font-bold tracking-tight text-ink">
            Hospital operations
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
            Only this wallet can mint records or create identities, and that gate lives in the
            contract — not in the interface. Everything below is read from chain state.
          </p>
        </div>
        {roles.admin ? (
          <Status state="active">DEFAULT_ADMIN_ROLE</Status>
        ) : (
          <Status state="denied">No admin role</Status>
        )}
      </header>

      {!roles.admin && (
        <Callout tone="warn" title="This wallet does not hold DEFAULT_ADMIN_ROLE">
          Mint attempts will revert — which is worth demonstrating once.
        </Callout>
      )}

      <DashboardBar
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={refreshFromChain}
        stats={stats}
      >
        <ExportButton
          filename="apnarecord-identities"
          label="Export identities"
          rows={identityRows}
          columns={[
            { key: 'label', label: 'Label' },
            { key: 'displayName', label: 'Display name' },
            { key: 'address', label: 'Wallet' },
            {
              key: 'roles',
              label: 'Roles',
              value: (row) =>
                [row.roles.admin && 'admin', row.roles.manager && 'manager', row.roles.auditor && 'auditor']
                  .filter(Boolean)
                  .join(' '),
            },
            { key: 'records', label: 'Records owned' },
            { key: 'consentsActive', label: 'Active consents' },
          ]}
        />
      </DashboardBar>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Registered identities"
          value={totals.identities}
          tone="peacock"
          hint={`${rolesAssigned} carry a role · ${totals.identities - rolesAssigned} unassigned`}
        />
        <StatCard
          label="Records minted"
          value={totals.records}
          tone="peacock"
          hint={`Soulbound, owned by patients · ${totals.events} chain events`}
        />
        <StatCard
          label="Active consents"
          value={totals.activeConsents}
          tone={totals.activeConsents > 0 ? 'success' : 'default'}
          hint={`${totals.expiredConsents} expired · ${totals.distinctViewers} distinct viewers`}
        />
        <StatCard
          label="Closing within 24h"
          value={totals.expiringSoon ?? 0}
          tone={(totals.expiringSoon ?? 0) > 0 ? 'marigold' : 'default'}
          hint={
            (totals.expiringSoon ?? 0) > 0
              ? 'About to lapse on their own — listed below'
              : 'Nothing lapses in the next day'
          }
          stale={Boolean(stats.stale)}
        />
      </div>

      <PanelBoundary name="The request queue">
        {openRequests.length > 0 ? (
          <Card
            tone="accent"
            title="Requested, not yet issued"
            subtitle="Clinicians have asked for these. The contract stores no request status, so this list is derived by matching each request against later mints."
            right={<Status state="pending">{openRequests.length} open</Status>}
          >
            <ul className="space-y-2.5">
              {openRequests.map((request) => (
                <li
                  key={request.requestId}
                  className="rounded-lg border border-marigold-200 bg-white/70 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone="slate">request #{request.requestId}</Pill>
                    <span className="text-xs font-semibold text-ink">
                      {humanType(request.recordType)}
                    </span>
                    <span className="text-[11px] text-slate-600">
                      for{' '}
                      {request.patientName ||
                        request.patientLabel ||
                        short(request.patient)}
                    </span>
                    <span className="ml-auto text-[11px] text-slate-500">
                      {request.requestedAt
                        ? `${relativeTime(request.requestedAt)} · ${absoluteTime(request.requestedAt)}`
                        : `block ${request.blockNumber}`}
                    </span>
                  </div>

                  <p className="mt-1.5 text-[11px] text-slate-600">
                    Requested by{' '}
                    <span className="font-medium">
                      {request.requesterLabel || short(request.requester)}
                    </span>
                  </p>
                  <p className="mono mt-1 break-all text-[10px] text-slate-500">
                    patient {request.patient}
                  </p>

                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Link
                      to={`/admin/console?patient=${request.patient}&type=${encodeURIComponent(request.recordType)}`}
                      className="btn-primary text-xs"
                    >
                      Encrypt and mint this record
                    </Link>
                    <button
                      type="button"
                      onClick={() =>
                        setDrawer({ type: 'identity', row: patientRowFor(request.patient) })
                      }
                      className="btn-secondary text-xs"
                    >
                      View the patient
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[13px] leading-relaxed text-slate-600">
              "Open" means no later mint exists for the same patient and record type. The contract
              cannot tell you more than that — <span className="mono">RecordMinted</span> does not
              echo the request it answers, so this is a sound inference rather than a stored fact.
            </p>
          </Card>
        ) : (
          <Card
            title="Requested, not yet issued"
            subtitle="Nothing is waiting on you right now."
          >
            <p className="text-[13px] leading-relaxed text-slate-500">
              {totals.requests > 0
                ? `All ${totals.requests} request${totals.requests === 1 ? '' : 's'} made on this contract now have a matching record.`
                : 'No clinician has requested a record on this contract yet. Requests appear here as soon as one is made.'}
            </p>
          </Card>
        )}
      </PanelBoundary>

      <PanelBoundary name="The expiry watchlist">
        <ExpiryWatchlist
          items={expiringSoon}
          title="Consent windows closing within 24 hours"
          note="Across every record on this contract"
        />
      </PanelBoundary>

      <div className="grid gap-4 lg:grid-cols-3">
        <PanelBoundary name="Consent window health">
          <ChartCard
            title="Consent window health"
            subtitle="Active against every window ever granted"
            footer={
              <p className="text-[13px] leading-relaxed text-slate-500">
                Windows close on their own — the contract enforces expiry with no intervention needed.
              </p>
            }
          >
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                <GaugeChart
                  value={totals.activeConsents}
                  max={Math.max(consentTotal, 1)}
                  label="active now"
                />
              </div>
              <div className="px-3 pb-1">
                <ProgressBar
                  value={consentHealth}
                  label="Active share of all windows"
                  sublabel={`${totals.activeConsents} / ${Math.max(consentTotal, 1)}`}
                />
              </div>
            </div>
          </ChartCard>
        </PanelBoundary>

        <PanelBoundary name="Identities by role">
          <ChartCard
            title="Identities by role"
            subtitle="Who holds what on this contract"
            right={
              <div className="w-32">
                <DonutLegend data={stats.identitiesByRole} />
              </div>
            }
          >
            <DonutChart data={stats.identitiesByRole} centerLabel="identities" />
          </ChartCard>
        </PanelBoundary>

        <PanelBoundary name="Records by type">
          <ChartCard title="Records by type" subtitle="What has been issued">
            <BarsChart data={stats.recordsByType} horizontal />
          </ChartCard>
        </PanelBoundary>
      </div>

      <PanelBoundary name="Contract activity">
        <ChartCard
          title="Contract activity"
          subtitle="Every state change is an on-chain event"
          height={230}
          right={<Pill tone="slate">{totals.events} events</Pill>}
        >
          <AreaTrend data={stats.activityByDay} label="events" />
        </ChartCard>
      </PanelBoundary>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">Administrative actions</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.title}
              to={action.to}
              className="group rounded-xl border border-line bg-white p-4 shadow-card transition hover:border-peacock-300 hover:shadow-raised"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-semibold text-ink group-hover:text-peacock-700">
                  {action.title}
                </p>
                <span aria-hidden="true" className="text-slate-300 transition group-hover:text-peacock-600">
                  →
                </span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">{action.detail}</p>
              <p className="mono mt-2 text-[9px] text-slate-400">requires {action.gate}</p>
            </Link>
          ))}
        </div>
      </section>

      <Card
        title="Identities on this contract"
        subtitle="Rebuilt from IdentityCreated logs, with roles read from AccessControl. Click a row for the full picture."
        right={<Pill tone="slate">{identityRows.length} shown</Pill>}
      >
        <PanelBoundary name="The identity table">
          <DataTable
            freezeFirstColumn
            rowKey={(row) => row.address}
            rows={pagedIdentities}
            total={identityRows.length}
            filtered={identityTable.isFiltered || roleFilter !== 'all'}
            empty="No identities yet"
            emptyFiltered="No identity matches these filters."
            onRowClick={(row) => setDrawer({ type: 'identity', row })}
            sort={identityTable.sort}
            onToggleSort={identityTable.toggleSort}
            page={identityTable.page}
            pageSize={identityTable.pageSize}
            totalPages={Math.max(1, Math.ceil(identityRows.length / identityTable.pageSize))}
            onPageChange={identityTable.setPage}
            onPageSizeChange={identityTable.setPageSize}
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input h-9 w-52 py-0 text-xs"
                  value={identityTable.query}
                  onChange={(event) => identityTable.setQuery(event.target.value)}
                  placeholder="Search name or address…"
                  aria-label="Search identities"
                />
                <div className="flex flex-wrap gap-1">
                  {ROLE_FILTERS.map((chip) => (
                    <button
                      key={chip.key}
                      type="button"
                      aria-pressed={roleFilter === chip.key}
                      onClick={() => {
                        setRoleFilter(chip.key);
                        identityTable.setPage(1);
                      }}
                      className={`rounded-institutional border px-2.5 py-1 text-[11px] font-medium transition ${
                        roleFilter === chip.key
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
                label: 'Holder',
                render: (row) => {
                  const name = row.displayName || nameFor(row.address, row.label);
                  return (
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-ink">{name}</span>
                      {row.displayName && <OffChainBadge />}
                    </div>
                  );
                },
              },
              { key: 'address', label: 'Wallet', mono: true, render: (row) => short(row.address) },
              {
                key: 'roles',
                label: 'Roles',
                align: 'center',
                sortable: false,
                render: (row) => {
                  const held = [
                    row.roles.admin && 'Admin',
                    row.roles.manager && 'Manager',
                    row.roles.auditor && 'Auditor',
                  ].filter(Boolean);
                  return held.length ? (
                    <div className="flex flex-wrap justify-center gap-1">
                      {held.map((role) => (
                        <Pill key={role} tone="peacock">
                          {role}
                        </Pill>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-400">None</span>
                  );
                },
              },
              {
                key: 'records',
                label: 'Records owned',
                align: 'right',
                render: (row) => <span className="tabular-nums">{row.records}</span>,
              },
              {
                key: 'consentsActive',
                label: 'Active consents',
                align: 'right',
                render: (row) => (
                  <span
                    className={`tabular-nums ${
                      row.consentsActive > 0 ? 'font-medium text-peacock-700' : 'text-slate-400'
                    }`}
                  >
                    {row.consentsActive}
                  </span>
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

      <Card
        title="Records on this contract"
        subtitle="Every minted token with its ownership and live consent count. Click a row for its history."
        right={<Pill tone="slate">{recordRows.length} shown</Pill>}
      >
        <PanelBoundary name="The records table">
          <DataTable
            freezeFirstColumn
            rowKey={(row) => row.tokenId}
            rows={pagedRecords}
            total={recordRows.length}
            filtered={recordTable.isFiltered || recordTypeFilter !== 'all'}
            empty="No records minted yet"
            emptyFiltered="No record matches these filters."
            onRowClick={(row) => setDrawer({ type: 'record', row })}
            sort={recordTable.sort}
            onToggleSort={recordTable.toggleSort}
            page={recordTable.page}
            pageSize={recordTable.pageSize}
            totalPages={Math.max(1, Math.ceil(recordRows.length / recordTable.pageSize))}
            onPageChange={recordTable.setPage}
            onPageSizeChange={recordTable.setPageSize}
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input h-9 w-52 py-0 text-xs"
                  value={recordTable.query}
                  onChange={(event) => recordTable.setQuery(event.target.value)}
                  placeholder="Search digest, owner, type…"
                  aria-label="Search records"
                />
                <div className="flex flex-wrap gap-1">
                  {['all', ...stats.recordsByType.map((entry) => entry.name)].map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={recordTypeFilter === type}
                      onClick={() => {
                        setRecordTypeFilter(type);
                        recordTable.setPage(1);
                      }}
                      className={`rounded-institutional border px-2.5 py-1 text-[11px] font-medium transition ${
                        recordTypeFilter === type
                          ? 'border-peacock-300 bg-peacock-50 text-peacock-700'
                          : 'border-line bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {type === 'all' ? 'All types' : humanType(type)}
                    </button>
                  ))}
                </div>
              </div>
            }
            columns={[
              {
                key: 'tokenId',
                label: 'Token',
                render: (row) => <Pill tone="slate">#{row.tokenId}</Pill>,
              },
              { key: 'recordType', label: 'Type', render: (row) => humanType(row.recordType) },
              {
                key: 'owner',
                label: 'Owner',
                render: (row) => (
                  <div className="flex items-center gap-1.5">
                    <span>{row.patientName || row.patientLabel || short(row.patient)}</span>
                    {row.patientName && <OffChainBadge />}
                  </div>
                ),
              },
              {
                key: 'recordHash',
                label: 'Digest',
                mono: true,
                sortable: false,
                render: (row) => <span className="block max-w-[12rem] truncate">{row.recordHash}</span>,
              },
              {
                key: 'readers',
                label: 'Can read now',
                align: 'right',
                render: (row) => (
                  <span
                    className={`tabular-nums ${
                      row.consentsActive > 0 ? 'font-medium text-peacock-700' : 'text-slate-400'
                    }`}
                  >
                    {row.consentsActive}
                  </span>
                ),
              },
              { key: 'mintedAtBlock', label: 'Block', align: 'right' },
            ]}
          />
        </PanelBoundary>
      </Card>

      <Card
        title="Record lifecycle"
        subtitle="Where the contract blocks actions — and the three exits that show the design working"
      >
        <LifecycleFlow />
      </Card>

      <p className="text-[11px] text-slate-500">
        Contract{' '}
        <a
          href={EXPLORER}
          target="_blank"
          rel="noreferrer"
          className="mono text-peacock-700 underline decoration-dotted underline-offset-2"
        >
          {CONTRACT_ADDRESS}
        </a>{' '}
        · read at {absoluteTime(lastUpdated)}
        {stats.cached && ' (from the server cache)'}
      </p>

      {/* ------------------------------------------------------------ drawer */}
      <Drawer
        open={Boolean(drawer)}
        onClose={() => setDrawer(null)}
        title={
          drawer?.type === 'identity'
            ? drawer.row.displayName || drawer.row.label || 'Identity'
            : drawer?.type === 'record'
              ? `Record #${drawer.row.tokenId} · ${humanType(drawer.row.recordType)}`
              : ''
        }
        subtitle={
          drawer?.type === 'identity'
            ? short(drawer.row.address)
            : drawer?.type === 'record'
              ? `owned by ${short(drawer.row.patient)}`
              : ''
        }
        footer={
          <div className="flex flex-wrap gap-2">
            <Link to="/admin/console" className="btn-primary">
              Open the operations console
            </Link>
            {drawer?.type === 'record' && (
              <a
                href={`${TX_EXPLORER}${drawer.row.mintedTx}`}
                target="_blank"
                rel="noreferrer"
                className="btn-secondary"
              >
                Mint transaction ↗
              </a>
            )}
          </div>
        }
      >
        {drawer?.type === 'identity' && (
          <PatientChart
            patient={drawer.row}
            stats={stats}
            profile={byAddress[String(drawer.row.address).toLowerCase()]}
            viewer={account}
            nameFor={nameFor}
          />
        )}
        {drawer?.type === 'record' && (
          <RecordDetail
            row={drawer.row}
            consents={consentsFor(drawer.row.tokenId)}
            onOpen={(row) => setReader(row)}
            canRead={stats.consents.some(
              (c) =>
                c.tokenId === drawer.row.tokenId &&
                c.active &&
                String(c.viewer).toLowerCase() === String(account || '').toLowerCase()
            )}
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

function RecordDetail({ row, consents, onOpen, canRead }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Pill tone="slate">#{row.tokenId}</Pill>
        <Pill tone="peacock">{humanType(row.recordType)}</Pill>
        {row.locked && <Status state="expired">soulbound</Status>}
        {row.burned && <Status state="revoked">burned</Status>}
      </div>

      {/* The hospital mints these records and then cannot read them. That is the
          design, and a button that proves it is worth more than a paragraph
          claiming it. */}
      <div className="rounded-lg border border-warn-200 bg-warn-50 p-3.5">
        <p className="text-xs font-semibold text-warn-700">Minting is not reading</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          This wallet administers the contract, but administration is not consent. Unless the patient
          has granted this exact address a window, the contract will refuse the read — try it.
        </p>
        <button type="button" onClick={() => onOpen(row)} className="btn-secondary mt-2.5 text-xs">
          {canRead ? 'Open report' : 'Attempt to open the report'}
        </button>
      </div>

      <section className="space-y-3 rounded-lg border border-line bg-white p-3.5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            On-chain digest
          </p>
          <p className="mono mt-1 break-all text-slate-700">{row.recordHash}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Owner</p>
            <p className="mono mt-1 break-all text-slate-700">{row.patient}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Issued
            </p>
            <p className="mt-1 text-xs text-slate-700">
              {row.mintedAt ? absoluteTime(row.mintedAt) : '—'}
              <span className="text-slate-400"> · block {row.mintedAtBlock}</span>
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Ordered by
            </p>
            <p className="mt-1 text-xs text-slate-700">
              {row.orderedByLabel || (row.orderedBy ? short(row.orderedBy) : 'no recorded request')}
              {row.requestId ? <span className="text-slate-400"> · request #{row.requestId}</span> : null}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Windows granted
            </p>
            <p className="mt-1 text-xs tabular-nums text-slate-700">
              {row.consentsActive} active / {row.consentsTotal} ever
            </p>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-ink">
          Who may read it ({consents.filter((c) => c.active).length} active)
        </h3>
        {consents.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            Nobody but the owner. Ownership is not a consent window — the patient can always read their
            own record.
          </p>
        ) : (
          <ul className="space-y-2">
            {consents.map((consent) => (
              <li
                key={`${consent.tokenId}-${consent.viewer}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-white px-3 py-2"
              >
                <span className="text-xs font-medium text-ink">
                  {consent.viewerLabel || short(consent.viewer)}
                </span>
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
          <RecordTimeline tokenId={row.tokenId} />
        </section>
      </PanelBoundary>
    </div>
  );
}
