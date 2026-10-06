'use client';

import { useEffect, useState } from 'react';

/**
 * Fail-closed network guard.
 *
 * The web app is built with a `NEXT_PUBLIC_NETWORK` label; the API owns the
 * authoritative `ZCASH_NETWORK`. If the two disagree (a mis-set Render env var,
 * a stale build, a testnet frontend pointed at a mainnet API), BLINK must not
 * quietly transact on the wrong network. This guard fetches the API's network
 * and, on any mismatch, replaces the app with a hard stop.
 *
 * It fails closed in both directions:
 *  - a mismatch renders the block screen and no app content;
 *  - if the network cannot be determined at all, the app is blocked rather than
 *    allowed to run unverified.
 */
const BUILD_NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? '') as '' | 'testnet' | 'mainnet';

type State =
  | { kind: 'checking' }
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: string; apiNetwork?: string };

export function NetworkGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'checking' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/v1/meta/network', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`network check failed (HTTP ${res.status})`);
        const { network } = (await res.json()) as { network: string };
        if (cancelled) return;
        if (BUILD_NETWORK && network !== BUILD_NETWORK) {
          setState({
            kind: 'blocked',
            reason: `This app is built for ${BUILD_NETWORK}, but the API is running on ${network}.`,
            apiNetwork: network,
          });
          return;
        }
        setState({ kind: 'ok' });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: 'blocked',
          reason: `Could not confirm the Zcash network: ${
            err instanceof Error ? err.message : 'unknown error'
          }.`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'checking') {
    return (
      <main className="shell">
        <p className="lede">Checking network…</p>
      </main>
    );
  }

  if (state.kind === 'blocked') {
    return (
      <main className="shell">
        <div className="stack">
          <div className="stack stack--sm">
            <p className="kicker">Network mismatch</p>
            <h1>BLINK is not available right now.</h1>
          </div>
          <div className="alert alert--error" role="alert">
            {state.reason}
          </div>
          <p className="tiny muted">
            BLINK refuses to run when the frontend and backend disagree about the Zcash network, to
            avoid any chance of a payment being made on the wrong chain. No funds have been moved.
          </p>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
