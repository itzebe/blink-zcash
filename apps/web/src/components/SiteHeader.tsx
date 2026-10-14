'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Primary navigation. The links are the real product actions, so the header
 * doubles as a way to reach every flow. On small screens the links collapse
 * behind a toggle so the header stays usable on a phone.
 */
const NAV = [
  { href: '/', label: 'Home' },
  { href: '/request', label: 'Create request' },
  { href: '/scan', label: 'Check a request' },
  { href: '/litepaper', label: 'Litepaper' },
];

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const isCurrent = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link href="/" className="brand" aria-label="BLINK home">
          <span className="brand__mark" aria-hidden="true">
            B
          </span>
          BLINK
        </Link>

        <div className="app-header__tools">
          <nav className="app-nav" id="app-nav" data-open={open} aria-label="Main">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="app-nav__link"
                aria-current={isCurrent(item.href) ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <button
            type="button"
            className="app-nav__toggle"
            aria-expanded={open}
            aria-controls="app-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '✕' : '☰'}
          </button>
        </div>
      </div>
    </header>
  );
}
