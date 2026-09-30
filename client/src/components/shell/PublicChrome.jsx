import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import Brand from '../Brand';

// Slim public chrome: the wordmark, the one public utility, and the dashboard door.
// No sidebar, no role navigation — those belong to the product shell, which only a
// connected wallet with a role ever sees.
//
// Kept on the paper shell so a visitor who arrives straight at /verify does not
// feel like they have left the product to go somewhere else.

const LINKS = [{ to: '/verify', label: 'Verify a record' }];

export default function PublicChrome({ children }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
          <Link to="/" className="flex items-center">
            <Brand size="sm" tone="dark" />
          </Link>
          <nav className="ml-2 hidden items-center gap-1 sm:flex">
            {LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm transition ${
                    isActive ? 'bg-peacock-50 font-medium text-peacock-800' : 'text-slate-600 hover:text-ink'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <Link to="/access" className="btn-primary">
              Access Dashboard
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-5 py-5 text-[11px] text-slate-500">
          <span>ApnaRecord</span>
          <span aria-hidden="true" className="text-slate-300">·</span>
          <span>Your records, your consent.</span>
        </div>
      </footer>
    </div>
  );
}
