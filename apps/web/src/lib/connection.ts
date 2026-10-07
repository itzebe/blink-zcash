/**
 * Connection lifecycle for the web app.
 *
 * The BLINK API runs on a hosting tier that spins down when idle, so the very
 * first request after a quiet period can take tens of seconds while the backend
 * boots. The old guard treated that window as a failure and replaced the whole
 * app with a "NETWORK MISMATCH" screen.
 *
 * This module keeps the app usable instead. It runs a background probe of the
 * API's authoritative network, exposes a small state machine, and only reports
 * `ready` once the API has genuinely answered with a network. The UI renders
 * immediately and stays interactive; it merely keeps the payment controls locked
 * until the network is confirmed, so a payment can never be made on an
 * unverified network.
 *
 * The state machine is deliberately framework-agnostic (no React, no DOM) so it
 * can be unit-tested directly; `ConnectionProvider` is a thin React wrapper.
 */

export type ZcashNetwork = 'testnet' | 'mainnet';

/** The network this build was compiled for (empty when not set). */
export const BUILD_NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? '') as '' | ZcashNetwork;

/** Number of failed probes after which the UI says "this is taking longer". */
export const SLOW_AFTER_ATTEMPTS = 5;

/** How often to re-confirm the network once the app is running. */
export const RECHECK_READY_MS = 5 * 60_000;

/**
 * Hard budget for a single network probe.
 *
 * A cold Render Free backend can take tens of seconds to answer, so this is
 * generous enough to let a waking service reply. It exists so the probe can
 * NEVER hang indefinitely: without it, a connection that stalls after the TCP
 * handshake (a half-open socket, a proxy that accepted the request but never
 * responds) leaves the fetch pending forever, `inFlight` stays true, and the
 * retry timer is never scheduled — the UI shows "Connecting…" indefinitely
 * instead of retrying. Bounding the probe guarantees that the worst case is a
 * `connecting` state followed by another attempt, and that a stalled backend
 * can never leave the app permanently stuck.
 */
export const PROBE_TIMEOUT_MS = 30_000;

export type ConnectionState =
  | { kind: 'connecting'; attempt: number; slow: boolean; reason?: string }
  | { kind: 'ready'; network: ZcashNetwork }
  | { kind: 'mismatch'; buildNetwork: string; apiNetwork: ZcashNetwork };

/**
 * Backoff between probe attempts: immediate, then ~1s growing by 1.5x up to a
 * 10s cap. A cold backend takes ~30s to answer, so a handful of attempts is
 * usually enough, and the cap keeps the app responsive without hammering the
 * service.
 */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(10_000, Math.round(1_000 * 1.5 ** (attempt - 1)));
}

export type ProbeResult =
  | { kind: 'ready'; network: ZcashNetwork }
  | { kind: 'mismatch'; buildNetwork: string; apiNetwork: ZcashNetwork }
  | { kind: 'retry'; reason: string };

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Ask the API for its authoritative network and interpret the answer.
 *
 * A transport error, a non-2xx (a 502 while the backend is still booting), or a
 * malformed body all yield `retry`: none of them is evidence that the networks
 * disagree, so none of them may produce a "mismatch". Only a well-formed
 * response whose network differs from the build is a mismatch.
 */
export async function probeNetwork(
  fetchImpl: FetchLike,
  baseUrl: string,
  buildNetwork: '' | ZcashNetwork,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/v1/meta/network`, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { kind: 'retry', reason: 'the BLINK service could not be reached' };
  }
  if (!res.ok) {
    // A 5xx (typically a 502 from the host) means the service is still waking.
    return { kind: 'retry', reason: `the BLINK service is starting (HTTP ${res.status})` };
  }
  let network: unknown;
  try {
    ({ network } = (await res.json()) as { network?: unknown });
  } catch {
    return { kind: 'retry', reason: 'the BLINK service returned an unreadable response' };
  }
  if (network !== 'testnet' && network !== 'mainnet') {
    return { kind: 'retry', reason: 'the BLINK service did not report a known network' };
  }
  if (buildNetwork && network !== buildNetwork) {
    return { kind: 'mismatch', buildNetwork, apiNetwork: network };
  }
  return { kind: 'ready', network };
}

export interface ConnectionMonitorOptions {
  fetchImpl: FetchLike;
  baseUrl: string;
  buildNetwork?: '' | ZcashNetwork;
  /** Timer functions, injectable for tests. Never call these as methods. */
  setTimeoutImpl?: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Framework-agnostic connection monitor. Callers subscribe to state changes and
 * drive `start`/`stop`/`pause`/`resume`/`retryNow` from their own lifecycle.
 */
export class ConnectionMonitor {
  private state: ConnectionState = { kind: 'connecting', attempt: 0, slow: false };
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private paused = false;
  private inFlight = false;

  private readonly buildNetwork: '' | ZcashNetwork;
  private readonly setTimeoutImpl: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly opts: ConnectionMonitorOptions) {
    this.buildNetwork = opts.buildNetwork ?? BUILD_NETWORK;
    // Wrap the globals instead of storing them bare: a browser `setTimeout`
    // invoked as `this.setTimeoutImpl(...)` throws "Illegal invocation" because
    // the receiver is the monitor, not `window`. The wrappers call it correctly.
    this.setTimeoutImpl =
      opts.setTimeoutImpl ?? ((handler, timeout) => setTimeout(handler, timeout));
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));
  }

  getState(): ConnectionState {
    return this.state;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(next: ConnectionState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.paused = false;
    this.attempt = 0;
    this.emit({ kind: 'connecting', attempt: 0, slow: false });
    void this.probe();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** Stop scheduling while the tab is hidden; the state is preserved. */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.state.kind !== 'ready') {
      this.retryNow();
    } else {
      this.schedule(RECHECK_READY_MS);
    }
  }

  /** User-initiated retry: restart the backoff and probe immediately. */
  retryNow(): void {
    this.clearTimer();
    this.stopped = false;
    this.paused = false;
    this.attempt = 0;
    this.emit({ kind: 'connecting', attempt: 0, slow: false });
    void this.probe();
  }

  private clearTimer(): void {
    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  private schedule(ms: number): void {
    if (this.stopped || this.paused) return;
    this.clearTimer();
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      void this.probe();
    }, ms);
  }

  private async probe(): Promise<void> {
    if (this.stopped || this.paused || this.inFlight) return;
    this.inFlight = true;
    // Bound the probe so a stalled backend can never leave the monitor waiting
    // forever (see PROBE_TIMEOUT_MS). The signal aborts the underlying fetch.
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutHandle = this.setTimeoutImpl(() => controller?.abort(), PROBE_TIMEOUT_MS);
    try {
      const result = await probeNetwork(
        this.opts.fetchImpl,
        this.opts.baseUrl,
        this.buildNetwork,
        controller?.signal,
      );
      if (this.stopped) return;
      if (result.kind === 'ready') {
        this.attempt = 0;
        this.emit({ kind: 'ready', network: result.network });
        // Keep confirming the network; a backend that goes away must re-lock the UI.
        this.schedule(RECHECK_READY_MS);
        return;
      }
      if (result.kind === 'mismatch') {
        this.emit({
          kind: 'mismatch',
          buildNetwork: result.buildNetwork,
          apiNetwork: result.apiNetwork,
        });
        // Re-check: a corrected deploy can resolve the mismatch without a reload.
        this.schedule(RECHECK_READY_MS);
        return;
      }
      this.attempt += 1;
      this.emit({
        kind: 'connecting',
        attempt: this.attempt,
        slow: this.attempt >= SLOW_AFTER_ATTEMPTS,
        reason: result.reason,
      });
      this.schedule(retryDelayMs(this.attempt));
    } finally {
      this.clearTimeoutImpl(timeoutHandle);
      this.inFlight = false;
    }
  }
}
