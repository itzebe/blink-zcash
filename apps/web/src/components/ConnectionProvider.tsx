'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  ConnectionMonitor,
  type ConnectionState,
  type ZcashNetwork,
} from '@/lib/connection';

interface ConnectionContextValue {
  state: ConnectionState;
  /** The confirmed network, or `null` until the API has answered. Never guessed. */
  network: ZcashNetwork | null;
  /** True once the API has confirmed the network and the app may take payments. */
  ready: boolean;
  retryNow: () => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

/**
 * Owns the single connection monitor for the app and shares it with the tree.
 *
 * The monitor runs entirely in the background: it never blocks rendering, and
 * the app is interactive from the first paint. Pages read `ready`/`network` to
 * decide whether payment controls may be enabled.
 */
export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const monitorRef = useRef<ConnectionMonitor | null>(null);
  if (monitorRef.current === null) {
    monitorRef.current = new ConnectionMonitor({ fetchImpl: fetch, baseUrl: '' });
  }
  const monitor = monitorRef.current;

  const state = useSyncExternalStore(
    (cb) => monitor.subscribe(cb),
    () => monitor.getState(),
    () => monitor.getState(),
  );

  useEffect(() => {
    monitor.start();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') monitor.resume();
      else monitor.pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      monitor.stop();
    };
  }, [monitor]);

  const value = useMemo<ConnectionContextValue>(() => {
    return {
      state,
      network: state.kind === 'ready' ? state.network : null,
      ready: state.kind === 'ready',
      retryNow: () => monitor.retryNow(),
    };
  }, [monitor, state]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within a ConnectionProvider');
  return ctx;
}

/**
 * A slim, non-blocking status strip. It sits at the top of the page and never
 * covers the app. When the backend is waking it explains what is happening
 * instead of replacing the screen; once connected it renders nothing.
 */
export function ConnectionStatus() {
  const { state, retryNow } = useConnection();
  if (state.kind !== 'connecting') return null;
  return (
    <div className="conn" role="status" aria-live="polite">
      <span className="conn__spinner" aria-hidden="true" />
      <span className="conn__text">
        {state.slow
          ? 'Still waking the BLINK service — the free backend sleeps when idle and can take up to a minute to start.'
          : 'Connecting to the BLINK service…'}
      </span>
      <button type="button" className="conn__retry" onClick={retryNow}>
        Retry now
      </button>
    </div>
  );
}

/**
 * The hard stop, shown only on a genuine network disagreement (a mis-set
 * environment variable or a stale build). This is a real misconfiguration, so
 * BLINK refuses to run rather than risk transacting on the wrong chain.
 */
export function NetworkMismatchScreen() {
  const { state, retryNow } = useConnection();
  if (state.kind !== 'mismatch') return null;
  return (
    <main className="shell">
      <div className="stack">
        <div className="stack stack--sm">
          <p className="kicker">Network mismatch</p>
          <h1>BLINK is not available right now.</h1>
        </div>
        <div className="alert alert--error" role="alert">
          This app is built for {state.buildNetwork}, but the API is running on {state.apiNetwork}.
        </div>
        <p className="tiny muted">
          BLINK refuses to run when the frontend and backend disagree about the Zcash network, to
          avoid any chance of a payment being made on the wrong chain. No funds have been moved.
        </p>
        <div className="btn-row">
          <button type="button" className="btn btn--ghost" onClick={retryNow}>
            Retry
          </button>
          <Link className="btn btn--ghost" href="/">
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}

/**
 * Renders its children immediately, alongside the non-blocking status strip. On
 * a genuine mismatch the children are replaced by the hard stop. The app is
 * never withheld merely because the backend is still waking.
 */
export function ConnectionGate({ children }: { children: React.ReactNode }) {
  const { state } = useConnection();
  return (
    <>
      <ConnectionStatus />
      {state.kind === 'mismatch' ? <NetworkMismatchScreen /> : children}
    </>
  );
}
