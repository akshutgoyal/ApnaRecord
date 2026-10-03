import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { isAddress } from 'ethers';
import { useChain } from '../chain';
import { facilityDetail } from '../services/api';
import { useTx } from '../hooks/useTx';
import AddressInput from '../components/AddressInput';
import LifecycleFlow from '../components/viz/LifecycleFlow';
import {
  Busy,
  Callout,
  Card,
  EmptyState,
  Field,
  PageHeader,
} from '../components/ui';

// The facility console. A hospital IT wallet links patients — only with their
// consent — sees the records of linked patients, and discharges them.
//
// What it can never do is the point of the page: it cannot link unilaterally,
// it cannot read file content (metadata only, via the scoped dashboard), and
// it cannot see a patient who revoked or was discharged.

export default function Hospital() {
  const { account, roles, writeAs, refresh } = useChain();
  const { run, isBusy } = useTx({ onDone: useCallback(() => refresh(), [refresh]) });

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [linkPatient, setLinkPatient] = useState('');
  const [dischargePatient, setDischargePatient] = useState('');

  const isHospital = roles.hospital;

  const load = useCallback(async () => {
    if (!account) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setDetail(await facilityDetail(account));
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    load();
  }, [load]);

  const requestLink = () =>
    run(
      'requestPatientLink',
      async () => {
        if (!isAddress(linkPatient)) throw new Error('A valid patient address is required.');
        // This grants nothing. The patient approves from their own console —
        // without that, this request is just a row nobody acts on.
        const tx = await writeAs('requestPatientLink', [linkPatient]);
        await tx.wait();
        setLinkPatient('');
        await load();
      },
      { successDetail: 'Link requested. It takes effect only when the patient approves it.' }
    );

  const discharge = () =>
    run(
      'dischargePatient',
      async () => {
        if (!isAddress(dischargePatient)) throw new Error('A valid patient address is required.');
        const tx = await writeAs('dischargePatient', [dischargePatient]);
        await tx.wait();
        setDischargePatient('');
        await load();
      },
      { successDetail: 'Discharged. This facility loses sight of every record that patient holds.' }
    );

  if (!account) {
    return (
      <>
        <PageHeader kicker="Facility · Hospital IT" title="Patients & links" />
        <EmptyState
          variant="blocked"
          title="Connect a wallet first"
          hint="Switch MetaMask to the hospital IT account to manage patient links."
        />
      </>
    );
  }

  const linked = detail?.linkedPatients || [];

  return (
    <>
      <PageHeader
        kicker="Facility · Hospital IT"
        title="Patients & links"
        lead="Request links patients approve, discharge patients who leave, and mint for patients who are linked. Linking is consent, not admission — it grants metadata visibility, never file content."
        aside={
          <button type="button" onClick={load} className="btn-secondary">
            Refresh
          </button>
        }
      />

      {!isHospital && (
        <Callout tone="warn" className="mb-5" title="This wallet does not hold HOSPITAL_ROLE">
          Link and discharge calls will revert. That is the contract refusing, and it is worth
          watching once — a modified frontend cannot talk its way past it.
        </Callout>
      )}

      {detail && !detail.registeredOnChain && (
        <Callout tone="warn" className="mb-5" title="Not registered as a facility">
          Ask the platform admin to call createFacility for this wallet first. Until then, link
          requests revert with NotAFacility.
        </Callout>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Request a patient link"
          subtitle="Asks. The patient approves from their console — nothing happens until then."
        >
          <div className="space-y-3">
            <AddressInput
              label="Patient address"
              value={linkPatient}
              onChange={setLinkPatient}
            />
            <button
              type="button"
              onClick={requestLink}
              disabled={isBusy('requestPatientLink')}
              className="btn-primary w-full"
            >
              {isBusy('requestPatientLink') ? <Busy label="Confirming…" /> : 'requestPatientLink'}
            </button>
          </div>
        </Card>

        <Card
          title="Discharge a patient"
          subtitle="One action: every record that patient holds leaves this facility's scope at once."
        >
          <div className="space-y-3">
            <AddressInput
              label="Patient address"
              value={dischargePatient}
              onChange={setDischargePatient}
            />
            <button
              type="button"
              onClick={discharge}
              disabled={isBusy('dischargePatient')}
              className="btn-danger w-full"
            >
              {isBusy('dischargePatient') ? <Busy label="Confirming…" /> : 'dischargePatient'}
            </button>
          </div>
        </Card>

        <Card
          className="lg:col-span-2"
          title={`Linked patients (${linked.length})`}
          subtitle="Current consent only — pending requests and ended links are not shown here."
        >
          {linked.length === 0 ? (
            <EmptyState
              title="Nobody linked right now"
              hint="Request a link above; it appears here once the patient approves."
            />
          ) : (
            <ul className="divide-y divide-line">
              {linked.map((entry) => (
                <li key={entry.patient} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="mono min-w-0 flex-1 truncate text-xs text-slate-600">
                    {entry.patient}
                  </span>
                  <Link
                    to={`/doctor/console?patient=${entry.patient}`}
                    className="text-[11px] font-medium text-peacock-700 underline"
                  >
                    Request a record
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* The facility's own arc, not the generic seven. The generic one spends most of
            its length on steps a hospital never takes -- minting to itself is not a thing,
            and granting access is the patient's alone -- so the boundary at the end of
            this one is the part worth reading. */}
        <div className="mt-4">
          <LifecycleFlow role="hospital" />
        </div>
      </div>

      <Field label="Minting for a linked patient" hint="The hospital mints from the admin console today — the gate is the link, not the page.">
        <div>
          <Link to="/admin/console" className="btn-secondary">
            Open the mint form
          </Link>
        </div>
      </Field>
    </>
  );
}
