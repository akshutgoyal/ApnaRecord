import React, { useEffect, useState } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { useChain, shortAddress } from '../../chain';
import { clearSession, forgetDevice } from '../../lib/session';
import { ROLES, CONTRACT_ADDRESS, EXPLORER } from '../../contract';
import Brand, { Logomark } from '../Brand';
import StatusBanner from '../StatusBanner';
import DemoBanner from './DemoBanner';
import { LiveDot } from '../ui';

// Application shell, shown ONLY inside a role's own console.
//
// Role isolation is the point: the sidebar renders the current wallet's section
// and nothing else — a patient sees "My records" plus the public links, never a
// doctor or admin entry. Combined with RoleGate (which decides which wallet may
// load which route at all), there is no cross-role surface to click into.
//
// Layout follows the conventions a data-dense product is expected to honour:
// 256px expanded / 64px collapsed, 36px nav items, an 8% peacock fill plus a 3px
// left rule for the active item, and a 200ms width transition with no reflow.

const SECTIONS = {
  admin: {
    title: 'Operations',
    items: [
      { to: '/admin', label: 'Dashboard', icon: '▤', end: true },
      { to: '/admin/console', label: 'Console', icon: '⌘' },
      { to: '/admin/auditlog', label: 'Audit trail', icon: '▦' },
    ],
  },
  doctor: {
    title: 'Clinical',
    items: [
      { to: '/doctor', label: 'Dashboard', icon: '▤', end: true },
      { to: '/doctor/console', label: 'Records & requests', icon: '⌘' },
    ],
  },
  hospital: {
    title: 'Facility',
    items: [
      { to: '/hospital', label: 'Dashboard', icon: '▤', end: true },
      { to: '/hospital/console', label: 'Patients & links', icon: '⌘' },
    ],
  },
  auditor: {
    title: 'Audit',
    items: [
      { to: '/auditor', label: 'Dashboard', icon: '▤', end: true },
      { to: '/auditor/console', label: 'Audit view', icon: '⌘' },
    ],
  },
  patient: {
    title: 'My records',
    items: [
      { to: '/patient', label: 'Dashboard', icon: '▤', end: true },
      { to: '/patient/console', label: 'Manage access', icon: '⌘' },
      { to: '/patient/profile', label: 'My profile', icon: '☺' },
    ],
  },
};

const PUBLIC_NAV = [
  { to: '/verify', label: 'Verify a record', icon: '✓' },
  { to: '/', label: 'Public site', icon: '◈', end: true },
];

const COLLAPSE_KEY = 'apnarecord-nav-collapsed';

function NavItem({ item, collapsed, onNavigate }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        [
          'relative flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition',
          isActive
            ? 'bg-peacock-600/10 font-semibold text-peacock-800 before:absolute before:inset-y-1 before:-left-3 before:w-[3px] before:rounded-r before:bg-peacock-600'
            : 'text-slate-600 hover:bg-slate-100 hover:text-ink',
          collapsed ? 'justify-center px-0' : '',
        ].join(' ')
      }
    >
      <span aria-hidden="true" className="w-4 shrink-0 text-center text-xs opacity-80">
        {item.icon}
      </span>
      {!collapsed && <span className="truncate">{item.label}</span>}
    </NavLink>
  );
}

function SectionLabel({ children, collapsed }) {
  if (collapsed) return <div className="my-3 h-px bg-line" aria-hidden="true" />;
  return (
    <p className="px-3 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
      {children}
    </p>
  );
}

export default function AppShell({ children }) {
  const { account, primaryRole, identity, roles, isPatient, isDemo, exitDemo, refresh, refreshing } =
    useChain();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const location = useLocation();

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* private mode — the preference simply does not persist */
    }
  }, [collapsed]);

  // Inside the shell a wallet always holds a role — RoleGate only renders this
  // subtree after that check passes. A null section here cannot happen in
  // practice, and if it did, showing only the public links is the safe failure.
  const section = primaryRole ? SECTIONS[primaryRole] : null;

  // Every role this wallet holds, so the topbar never contradicts the page.
  const heldRoles = [
    roles.admin && 'Admin',
    roles.hospital && 'Hospital',
    roles.manager && 'Manager',
    roles.auditor && 'Auditor',
    isPatient && 'Patient',
  ].filter(Boolean);

  const close = () => setOpen(false);
  const railWidth = collapsed ? 'lg:w-16' : 'lg:w-64';
  const navigate = useNavigate();

  // Logout means two different things depending on which wallet this is.
  //
  // A demo persona holds no key, so there is nothing to forget and leaving the demo is
  // the whole action. A real session is different: the sealed key lives in IndexedDB, and
  // removing it is NOT recoverable without the recovery code — so it is confirmed.
  //
  // Confirmed HERE, not with `window.confirm`. That was the first version, and it failed
  // silently: browsers suppress repeated dialogs, and a suppressed `confirm` returns false
  // without drawing anything. So the click did nothing and said nothing — which is how
  // "the logout button does not work" can be the only symptom you ever see. The most
  // destructive control in the app cannot depend on a dialog the browser may swallow.
  const [confirmLogout, setConfirmLogout] = useState(false);

  const logout = async () => {
    if (isDemo) {
      exitDemo();
      navigate('/access');
      return;
    }

    try {
      await forgetDevice();
    } catch {
      /* nothing stored to forget — the unlocked marker still needs clearing */
    }
    clearSession();

    // An injected wallet is not something we can forget.
    //
    // A device key lives in IndexedDB and `forgetDevice` deletes it. MetaMask's account is
    // simply always there — so /access redirected straight back to this console
    // (Access.jsx sends any connected wallet holding a role to its own page), and logging
    // out looked like it did nothing. Disconnecting has to be an actual disconnect.
    //
    // `wallet_revokePermissions` is the only way a page can do that. Where a wallet does
    // not support it we say so rather than pretending: landing back here in silence is
    // what made this look like a broken button in the first place.
    const injected = typeof window !== 'undefined' ? window.ethereum : null;
    if (injected?.request) {
      try {
        await injected.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }],
        });
      } catch {
        window.alert(
          'Logged out here, but your wallet is still connected to this site. ' +
            'Open MetaMask and disconnect it, or switch accounts.'
        );
      }
    }

    navigate('/access');
  };

  return (
    <div className="flex min-h-screen bg-paper">
      {/* ---------------------------------------------------------- sidebar */}
      {/* `lg:static` put the rail back into the document flow on desktop, so it scrolled
          away with the page — the nav left the screen the moment you scrolled a long
          dashboard. `lg:sticky` pins it instead.

          Sticky rather than fixed on purpose: a sticky element still occupies flow space,
          so the flex row below keeps offsetting the main column by exactly the rail's
          width. Pinning it with `fixed` would have lifted it out of the layout and put it
          on top of the content, and the offset would then have to be hard-coded — a number
          that drifts the moment the rail collapses to 64px. `lg:inset-y-auto` clears the
          `inset-y-0` the mobile drawer needs, and `lg:h-screen` gives it the viewport to
          scroll within. */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-white
                    transition-[transform,width] duration-200
                    lg:sticky lg:inset-y-auto lg:top-0 lg:h-screen lg:translate-x-0 ${railWidth} ${
                      open ? 'translate-x-0' : '-translate-x-full'
                    }`}
      >
        <div className={`flex h-16 shrink-0 items-center border-b border-line ${collapsed ? 'lg:justify-center lg:px-0' : ''} px-4`}>
          <Link to="/" className="flex items-center" onClick={close}>
            {collapsed ? <Logomark className="hidden h-8 w-8 lg:block" /> : null}
            <span className={collapsed ? 'lg:hidden' : ''}>
              <Brand size="sm" tone="dark" />
            </span>
          </Link>
        </div>

        <div className={`flex-1 px-3 py-2 ${collapsed ? 'lg:px-2' : ''}`}>
          {section && (
            <>
              <SectionLabel collapsed={collapsed}>{section.title}</SectionLabel>
              <nav className="space-y-0.5">
                {section.items.map((item) => (
                  <NavItem key={item.to} item={item} collapsed={collapsed} onNavigate={close} />
                ))}
              </nav>
            </>
          )}

          <SectionLabel collapsed={collapsed}>Public</SectionLabel>
          <nav className="space-y-0.5">
            {PUBLIC_NAV.map((item) => (
              <NavItem key={item.to} item={item} collapsed={collapsed} onNavigate={close} />
            ))}
          </nav>

          {!collapsed && (
            <div className="mt-4 rounded-lg border border-line bg-slate-50 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Contract
              </p>
              <a
                href={EXPLORER}
                target="_blank"
                rel="noreferrer"
                className="mono mt-1 block break-all text-[10px] text-peacock-700 underline decoration-dotted underline-offset-2"
              >
                {CONTRACT_ADDRESS}
              </a>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
                Sepolia · reads via the server. Every write is signed in your wallet.
              </p>
            </div>
          )}
        </div>

        {/* Footer: who you are, on what network, holding what role. The chain,
            not the wallet, is the authority — so this is read, never chosen. */}
        {account && (
          <div className={`shrink-0 border-t border-line p-3 ${collapsed ? 'lg:px-2' : ''}`}>
            <Link
              to="/access"
              onClick={close}
              title={isDemo ? 'Exit demo or switch persona' : 'Switch wallet'}
              className={`flex items-center gap-2.5 rounded-lg border border-line p-2 transition hover:border-peacock-300 hover:bg-peacock-50/50 ${
                collapsed ? 'lg:justify-center' : ''
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ${
                  isDemo ? 'bg-marigold-100 text-marigold-700' : 'bg-peacock-50 text-peacock-700'
                }`}
              >
                {(identity.label || account).slice(0, 1).toUpperCase()}
              </span>
              {!collapsed && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold leading-tight text-ink">
                    {identity.label || 'Unregistered'}
                    {isDemo && <span className="ml-1 font-medium text-marigold-700">· demo</span>}
                  </span>
                  <span className="mono block text-[10px] leading-tight text-slate-400">
                    {shortAddress(account)}
                  </span>
                </span>
              )}
            </Link>
            {!collapsed && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 px-0.5">
                <span className="inline-flex items-center gap-1.5 rounded-institutional bg-peacock-50 px-2 py-0.5 text-[12px] font-semibold text-peacock-800 ring-1 ring-inset ring-peacock-200">
                  {primaryRole ? ROLES[primaryRole].label : 'No role'}
                  {heldRoles.length > 1 && ` +${heldRoles.length - 1}`}
                </span>
                <span className="text-[10px] text-slate-400">Sepolia</span>
              </div>
            )}

            {/* Sits under the identity block, with the role chip, because it is the same
                question: which wallet am I, and how do I stop being it. */}
            {!collapsed &&
              (confirmLogout ? (
                <div className="mt-1.5 rounded-lg border border-line bg-slate-50 p-2">
                  <p className="text-[10px] leading-snug text-error-700">
                    Removes this wallet from this device. You will need your recovery code
                    to sign back in.
                  </p>
                  <div className="mt-1.5 flex gap-1">
                    <button
                      type="button"
                      onClick={logout}
                      className="btn-danger flex-1 px-2 py-1 text-[11px]"
                    >
                      Log out
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmLogout(false)}
                      className="btn-ghost px-2 py-1 text-[11px]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => (isDemo ? logout() : setConfirmLogout(true))}
                  className="btn-ghost mt-1.5 w-full justify-start px-2 py-1 text-[11px]"
                >
                  {isDemo ? 'Exit demo' : 'Log out'}
                </button>
              ))}
          </div>
        )}

        {/* Collapse is a rail control, desktop only — on mobile the drawer is
            already resolved by the hamburger. */}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          className="hidden shrink-0 items-center justify-center gap-2 border-t border-line py-2 text-[11px] text-slate-500 transition hover:bg-slate-50 hover:text-ink lg:flex"
        >
          <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
          {!collapsed && 'Collapse'}
        </button>
      </aside>

      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={close}
          className="fixed inset-0 z-30 bg-ink/30 lg:hidden"
        />
      )}

      {/* ------------------------------------------------------------ main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-white/90 px-4 backdrop-blur">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
            aria-label="Toggle navigation"
          >
            ☰
          </button>

          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">
              {section ? `${section.title} console` : 'ApnaRecord'}
            </p>
            <p className="truncate text-[11px] text-slate-500">
              {location.pathname.replace(/^\//, '').replace(/\//g, ' · ') || 'home'}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => refresh()}
              disabled={refreshing}
              title="Re-read your role from the contract"
              className="hidden items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] text-slate-600 transition hover:bg-slate-50 sm:inline-flex"
            >
              {refreshing ? (
                <>
                  <LiveDot tone="peacock" /> Reading…
                </>
              ) : (
                'Refresh'
              )}
            </button>

            {isDemo && (
              <button
                type="button"
                onClick={exitDemo}
                className="rounded-md border border-marigold-200 bg-marigold-50 px-2.5 py-1 text-[11px] font-medium text-marigold-700 transition hover:bg-marigold-100"
              >
                Exit demo
              </button>
            )}
          </div>
        </header>

        <StatusBanner />

        <main className="min-w-0 flex-1 p-4 lg:p-6">
          {isDemo && <DemoBanner onExit={exitDemo} />}
          {children}
        </main>
      </div>
    </div>
  );
}
