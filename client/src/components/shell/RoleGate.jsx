import React from 'react';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { useChain } from '../../chain';
import { ROLES } from '../../contract';
import { Card, Callout } from '../ui';

/**
 * Gate a console behind the role the contract says this wallet holds.
 *
 * Three ways through:
 *   - a connected wallet holding the role      -> render
 *   - a demo persona holding the role          -> render (reads only; writes refuse)
 *   - neither                                  -> /access, with where they were headed
 *   - wallet/persona holding a DIFFERENT role  -> the console they DO hold
 *
 * The role is never taken from the URL or from storage, so a bookmarked link cannot
 * put someone into a console they are not entitled to see.
 */
export default function RoleGate({ role, children }) {
  const { account, primaryRole, roles, isPatient, isDemo, bootstrapped, hasWallet, hasLocalSession, locked } =
    useChain();
  const location = useLocation();

  // A wallet is on this device, wrapped, waiting for the device secret. That is NOT
  // "no wallet": sending them to /access would invite them to create a second account
  // for records that already exist, which is exactly what happens if a locked session is
  // treated as a signed-out one.
  if (locked) {
    return <Navigate to="/unlock" replace state={{ from: location.pathname }} />;
  }

  // Nothing can ever resolve an address here, so a redirect is the honest answer
  // and waiting would only show a spinner that never ends.
  //
  // `hasLocalSession` counts: a wallet created here needs no extension, so without
  // it a signed-in user would be treated as untouchable and bounced.
  const cannotResolve = !hasWallet && !isDemo && !hasLocalSession;

  // Session state settles asynchronously — a demo persona is read from session
  // storage, and a wallet is re-attached via eth_accounts. Redirecting on the
  // first render would bounce a perfectly valid visitor to /access before either
  // had a chance to resolve, which is what made deep-linking a console fail.
  if (!cannotResolve && !bootstrapped) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <div className="flex items-center gap-2.5 text-sm text-slate-500">
          <span
            aria-hidden="true"
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {isDemo
            ? 'Restoring your demo session…'
            : hasLocalSession
              ? 'Opening your wallet…'
              : 'Reading your role from the contract…'}
        </div>
      </div>
    );
  }

  if (!account) {
    return <Navigate to="/access" replace state={{ from: location.pathname }} />;
  }

  const holds =
    role === 'admin'
      ? roles.admin
      : role === 'hospital'
        ? roles.hospital
        : role === 'doctor'
          ? roles.manager
          : role === 'auditor'
            ? roles.auditor
            : isPatient;

  if (!holds) {
    if (primaryRole && primaryRole !== role) {
      // They hold a different role. Send them where they belong rather than
      // showing an error they cannot act on.
      return <Navigate to={ROLES[primaryRole].path} replace state={{ from: location.pathname }} />;
    }
    return (
      <div className="mx-auto max-w-lg px-5 py-16">
        <Card title="This wallet holds no role on this contract">
          <p className="text-sm leading-relaxed text-slate-600">
            Nothing is wrong — this address was simply never registered. An administrator has to
            create an identity for it and grant a role before a console can open.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/access" className="btn-primary">
              Use a different wallet
            </Link>
            <Link to="/verify" className="btn-secondary">
              Verify a record instead
            </Link>
          </div>
        </Card>
        <Callout tone="info" className="mt-4" title="Want to see the consoles anyway?">
          <Link to="/access" className="font-semibold underline">
            Open the demo walkthrough
          </Link>{' '}
          — every console, real chain data, no wallet required, writes refused.
        </Callout>
      </div>
    );
  }

  return children;
}
