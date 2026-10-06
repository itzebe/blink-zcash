'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
 *
 * A short bounded retry absorbs transient failures (a Render free instance cold
 * starting, a dropped request) so the guard does not block a healthy app; after
 * the retries are exhausted the block screen offers a manual retry.
 */
const BUILD_NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? '') as '' | 'testnet' | 'mainnet';
const ATTEMPTS = 4;
const RETRY_DELAY_MS = 1500;

type State =
  | { kind: 'checking' }
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: string; apiNetwork?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function NetworkGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const runIdRef = useRef(0);

  const check = useCallback(async () => {
    const runId = ++runIdRef.current;
    setState({ kind: 'checking' });
    let lastError = 'unknown error';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        const res = await fetch('/v1/meta/network', { headers: { accept: 'application/json' } });
        if (runId !== runIdRef.current) return;
        if (!res.ok) throw new Error(`network check failed (HTTP ${res.status})`);
        const { network } = (await res.json()) as { network: string };
        if (runId !== runIdRef.current) return;
        if (BUILD_NETWORK && network !== BUILD_NETWORK) {
          setState({
            kind: 'blocked',
            reason: `This app is built for ${BUILD_NETWORK}, but the API is running on ${network}.`,
            apiNetwork: network,
          });
          return;
        }
        setState({ kind: 'ok' });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'unknown error';
        if (attempt < ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
      }
    }
    if (runId !== runIdRef.current) return;
    setState({ kind: 'blocked', reason: `Could not confirm the Zcash network: ${lastError}.` });
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

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
          <button type="button" className="btn btn--ghost" onClick={() => void check()}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
