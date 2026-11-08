'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import ThemeToggle from './theme-toggle';

const screens = [
  {
    href: '/dashboard',
    label: 'Current runs',
    icon: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  },
  { href: '/dashboard/new', label: 'New run', icon: 'M12 5v14M5 12h14' },
  {
    href: '/dashboard/history',
    label: 'Run history',
    icon: 'M3 12a9 9 0 1 0 3-6.7M3 3v5h5m4-1v5l3 2',
  },
  {
    href: '/dashboard/settings',
    label: 'Settings',
    icon: 'm9.7 3-.5 2-1.6.9-2-.6-2.2 3.8 1.5 1.4v1.9l-1.5 1.4 2.2 3.8 2-.6 1.6.9.5 2h4.6l.5-2 1.6-.9 2 .6 2.2-3.8-1.5-1.4v-1.9l1.5-1.4-2.2-3.8-2 .6-1.6-.9-.5-2ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  },
];

export default function WorkspaceSidebar({ activeCount }: { activeCount: number }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <>
      <button
        className="ws-mobile-toggle"
        aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        ☰
      </button>
      {mobileOpen ? (
        <button
          className="ws-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <aside
        className="ws-sidebar"
        data-collapsed={collapsed}
        data-open={mobileOpen}
        aria-label="Workspace navigation"
      >
        <div className="ws-brand-row">
          <Link href="/" className="ws-brand" aria-label="Sightline home">
            <svg viewBox="0 0 32 40" width="22" height="28" fill="currentColor" aria-hidden="true">
              <path d="M3 2v29l8-7 7 14 6-3-7-14h12L3 2Z" />
            </svg>
            <span>Sightline.</span>
          </Link>
          <button
            className="ws-collapse"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="M9 4v16" />
            </svg>
          </button>
        </div>
        <div className="ws-space">
          <span className="ws-space-mark">S</span>
          <span>
            Visual testing lab<small>Local workspace</small>
          </span>
        </div>
        <span className="ws-group-label">WORKSPACE</span>
        <nav>
          {screens.map((screen) => {
            const active =
              screen.href === '/dashboard'
                ? pathname === '/dashboard' || pathname.startsWith('/agent/')
                : pathname === screen.href;
            return (
              <Link
                key={screen.href}
                href={screen.href}
                title={screen.label}
                aria-current={active ? 'page' : undefined}
                onClick={() => setMobileOpen(false)}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d={screen.icon} />
                </svg>
                <span>{screen.label}</span>
                {screen.href === '/dashboard' && activeCount > 0 ? <b>{activeCount}</b> : null}
              </Link>
            );
          })}
        </nav>
        <div className="ws-sidebar-bottom">
          <div className="ws-bottom-row">
            <Link href="/" title="Back to website">
              <span aria-hidden="true">↗</span>
              <span>Back to website</span>
            </Link>
            <ThemeToggle inline />
          </div>
        </div>
      </aside>
    </>
  );
}
