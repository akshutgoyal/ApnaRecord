import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useChain } from '../../chain';
import { useStats } from '../../hooks/useDashboardData';
import { facilityDetail } from '../../services/api';
import {
  ChartCard,
  DataTable,
  EmptyPanel,
  StatCard,
} from '../../components/viz/primitives';
import { Callout, Card, SkeletonCards } from '../../components/ui';
import PanelBoundary from '../../components/PanelBoundary';
import { DashboardBar } from '../../components/DashboardBar';
import ExpiryWatchlist from '../../components/ExpiryWatchlist';
import LifecycleFlow from '../../components/viz/LifecycleFlow';
import { shortAddress as short, relativeTime } from '../../lib/format';

// The facility's own dashboard. Every number here is scoped to the patients
// currently linked to this hospital — discharged patients vanish from it at
// once, which is the entire point of the link model. Chain-wide activity
// stays global and is labelled as such.

export default function HospitalDashboard() {
  const { account } = useChain();
  const { stats, loading, error, lastUpdated, refreshing, refreshFromChain } = useStats({
    facility: account,
  });
  const [facility, setFacility] = useState(null);

  const loadFacility = useCallback(async () => {
    if (!account) return;
    try {
      setFacility(await facilityDetail(account));
    } catch {
      setFacility(null);
    }
  }, [account]);

  useEffect(() => {
    loadFacility();
  }, [loadFacility]);

  if (loading) return <SkeletonCards count={4} />;
  if (error) {
    return (
      <Callout tone="error" title="Could not load facility data">
        {error}
      </Callout>
    );
  }

  const linked = facility?.linkedPatients || [];
  const records = stats?.records || [];
  const expiring = stats?.expiringSoon || [];

  return (
    <div className="space-y-5">
      <DashboardBar
        lastUpdated={lastUpdated}
        refreshing={refreshing}
        onRefresh={refreshFromChain}
        stats={stats}
      >
        {stats?.scoped && (
          <span className="text-[11px] text-slate-500">
            scoped to facility <span className="mono">{account ? short(account) : ''}</span>
          </span>
        )}
      </DashboardBar>

      {!facility?.registeredOnChain && (
        <Callout tone="warn" title="Not registered as a facility yet">
          This wallet holds no facility registration on-chain. Ask the platform admin to call
          createFacility for it before linking patients.
        </Callout>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Linked patients" value={linked.length} hint="consented, current" />
        <StatCard label="Records in scope" value={records.length} hint="linked patients only" />
        <StatCard
          label="Open requests"
          value={stats?.totals?.openRequests ?? 0}
          hint="in scope"
        />
        <StatCard label="Windows expiring" value={expiring.length} hint="within 24 hours" />
      </div>

      <PanelBoundary title="Linked patients">
        <ChartCard
          title="Currently linked patients"
          subtitle="Consent is theirs to withdraw at any time — discharge or revocation removes them here immediately"
          right={
            <Link to="/hospital/console" className="btn-secondary text-xs">
              Manage links
            </Link>
          }
        >
          {linked.length === 0 ? (
            <EmptyPanel
              title="No linked patients"
              hint="Request a link from the console; the patient approves it from theirs."
            />
          ) : (
            <DataTable
              columns={[
                { key: 'patient', label: 'Patient' },
                { key: 'consentedAt', label: 'Linked since' },
                { key: 'records', label: 'Records' },
              ]}
              rows={linked.map((entry) => {
                const count = records.filter(
                  (r) => r.patient && r.patient.toLowerCase() === entry.patient.toLowerCase()
                ).length;
                return {
                  patient: short(entry.patient),
                  consentedAt: entry.consentedAt ? relativeTime(entry.consentedAt) : '—',
                  records: count,
                };
              })}
            />
          )}
        </ChartCard>
      </PanelBoundary>

      <PanelBoundary title="Expiring windows">
        <ExpiryWatchlist items={expiring} />
      </PanelBoundary>

      <Card
        title="Record lifecycle"
        subtitle="Where the contract blocks you — the link gates the action, not the content"
      >
        <LifecycleFlow role="hospital" />
      </Card>
    </div>
  );
}
