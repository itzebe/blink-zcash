'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell, TopBar, Alert } from '@/components/Shell';
import { statusLabel } from '@/lib/status';

interface ActivityRecord {
  shortCode: string;
  recipientName: string;
  amount: string;
  currency: string;
  memo: string | null;
  network: 'testnet' | 'mainnet';
  status: string;
  confirmations: number;
  txidShort: string | null;
  expiresAt: string;
  createdAt: string;
}

const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

/**
 * Local activity.
 *
 * BLINK has no server-side account system in this MVP, so activity is
 * reconstructed from the management tokens this device stored when requests were
 * created. Another device cannot read them, and none of these records grant
 * access to funds.
 */
export default function ActivityPage() {
  const [items, setItems] = useState<ActivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const codes: string[] = [];
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key?.startsWith('blink:manage:')) codes.push(key.slice('blink:manage:'.length));
      }
    } catch {
      setError('Local activity is unavailable in this browser.');
      setLoading(false);
      return;
    }

    if (codes.length === 0) {
      setLoading(false);
      return;
    }

    const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
    Promise.all(
      codes.map(async (code) => {
        try {
          const res = await fetch(`${base}/v1/payment-requests/${encodeURIComponent(code)}`);
          if (!res.ok) return null;
          const json = (await res.json()) as { request: ActivityRecord };
          return json.request;
        } catch {
          return null;
        }
      }),
    )
      .then((rows) => {
        const valid = rows.filter((r): r is ActivityRecord => r !== null);
        valid.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        setItems(valid);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <Shell>
      <TopBar network={NETWORK} />
      <div className="stack">
        <div className="stack stack--sm">
          <p className="kicker">Activity</p>
          <h1>Your requests.</h1>
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}

        {loading ? (
          <p className="lede">Loading…</p>
        ) : items.length === 0 ? (
          <div className="card empty">
            <p>No payment requests on this device yet.</p>
            <Link className="btn btn--primary" href="/request" style={{ marginTop: 16 }}>
              Create a request
            </Link>
          </div>
        ) : (
          <div className="card card--flush">
            {items.map((item) => {
              const confirmed = item.status === 'CONFIRMED';
              const failed = ['FAILED', 'EXPIRED', 'CANCELLED'].includes(item.status);
              const markClass = confirmed
                ? 'activity-item__mark activity-item__mark--ok'
                : failed
                  ? 'activity-item__mark activity-item__mark--bad'
                  : 'activity-item__mark';
              const mark = confirmed ? '✓' : failed ? '✕' : '◷';
              return (
                <Link
                  key={item.shortCode}
                  href={`/pay/${item.shortCode}`}
                  className="activity-item"
                >
                  <span className={markClass} aria-hidden="true">
                    {mark}
                  </span>
                  <span className="activity-item__body">
                    <span className="activity-item__title" style={{ display: 'block' }}>
                      {item.memo ?? item.recipientName}
                    </span>
                    <span className="activity-item__meta">
                      {statusLabel(item.status)} · {new Date(item.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <span className="activity-item__amount">
                    {item.amount} {item.currency}
                  </span>
                </Link>
              );
            })}
          </div>
        )}

        <p className="tiny muted">
          Activity is stored on this device only. BLINK holds no funds and no account keys.
        </p>
      </div>
    </Shell>
  );
}
