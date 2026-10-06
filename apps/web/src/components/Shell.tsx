import type { ReactNode } from 'react';
import Link from 'next/link';

export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={wide ? 'shell shell--wide' : 'shell'}>{children}</main>;
}

/**
 * Network badge. Mainnet is rendered in the danger colour so it is impossible to
 * mistake a real-funds session for a test session. A null network (still loading,
 * or unknown) renders a neutral badge rather than guessing testnet.
 */
export function NetworkPill({ network }: { network: 'testnet' | 'mainnet' | null }) {
  if (network === null) {
    return <span className="network-pill">Zcash</span>;
  }
  const isMainnet = network === 'mainnet';
  return (
    <span className={isMainnet ? 'network-pill network-pill--mainnet' : 'network-pill'}>
      {isMainnet ? 'Zcash Mainnet' : 'Zcash Testnet'}
    </span>
  );
}

export function TopBar({
  network,
  right,
}: {
  network: 'testnet' | 'mainnet' | null;
  right?: ReactNode;
}) {
  return (
    <header className="topbar">
      <Link href="/" className="wordmark" aria-label="BLINK home">
        BLINK
      </Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link
          href="/scan"
          className="btn btn--ghost btn--small"
          style={{ padding: '6px 12px', minHeight: 32, fontSize: 12, borderRadius: 999 }}
        >
          Check a request
        </Link>
        {right ?? <NetworkPill network={network} />}
      </div>
    </header>
  );
}

export function StatusBadge({
  status,
  label,
  tone,
}: {
  status: string;
  label: string;
  tone: string;
}) {
  const toneClass = tone === 'neutral' ? '' : ` status--${tone}`;
  return (
    <span
      className={`status${toneClass}`}
      role="status"
      data-status={status}
      aria-label={`Status: ${label}`}
    >
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      <span className="row__value">{children}</span>
    </div>
  );
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'warn';
  children: ReactNode;
}) {
  const cls = kind === 'info' ? 'alert alert--info' : `alert alert--${kind}`;
  return (
    <div className={cls} role={kind === 'error' ? 'alert' : undefined}>
      {children}
    </div>
  );
}
