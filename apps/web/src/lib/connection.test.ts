import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectionMonitor,
  RECHECK_READY_MS,
  SLOW_AFTER_ATTEMPTS,
  probeNetwork,
  retryDelayMs,
} from './connection.js';

/** A queued probe outcome for the fetch stub below. */
type QueuedResponse =
  | { kind: 'ready'; network: 'testnet' | 'mainnet' }
  | { throw: true }
  | { http: number; body?: unknown };

/** Build a fetch stub that returns a queued sequence of responses. */
function fetchSequence(responses: QueuedResponse[]) {
  let i = 0;
  const fetchImpl = vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!next) throw new Error('no response queued');
    if ('throw' in next) throw new TypeError('fetch failed');
    if ('http' in next) {
      return {
        ok: next.http >= 200 && next.http < 300,
        status: next.http,
        json: async () => next.body ?? {},
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ network: next.network }),
    };
  });
  return fetchImpl;
}

describe('retryDelayMs', () => {
  it('probes immediately, then backs off with a cap', () => {
    expect(retryDelayMs(0)).toBe(0);
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(1500);
    expect(retryDelayMs(3)).toBe(2250);
    expect(retryDelayMs(50)).toBe(10_000);
  });
});

describe('probeNetwork', () => {
  it('reports ready when the API network matches the build', async () => {
    const fetchImpl = fetchSequence([{ kind: 'ready', network: 'mainnet' }]);
    await expect(probeNetwork(fetchImpl, '', 'mainnet')).resolves.toEqual({
      kind: 'ready',
      network: 'mainnet',
    });
  });

  it('reports ready when the build has no network label', async () => {
    const fetchImpl = fetchSequence([{ kind: 'ready', network: 'testnet' }]);
    await expect(probeNetwork(fetchImpl, '', '')).resolves.toEqual({
      kind: 'ready',
      network: 'testnet',
    });
  });

  it('reports a mismatch when the build and API disagree', async () => {
    const fetchImpl = fetchSequence([{ kind: 'ready', network: 'testnet' }]);
    await expect(probeNetwork(fetchImpl, '', 'mainnet')).resolves.toEqual({
      kind: 'mismatch',
      buildNetwork: 'mainnet',
      apiNetwork: 'testnet',
    });
  });

  it('retries, never mismatches, on a transport error', async () => {
    const fetchImpl = fetchSequence([{ throw: true }]);
    const result = await probeNetwork(fetchImpl, '', 'mainnet');
    expect(result.kind).toBe('retry');
  });

  it('retries on a 502 while the backend is still booting', async () => {
    const fetchImpl = fetchSequence([{ http: 502 }]);
    const result = await probeNetwork(fetchImpl, '', 'mainnet');
    expect(result.kind).toBe('retry');
  });

  it('retries on a malformed body rather than treating it as a mismatch', async () => {
    const fetchImpl = fetchSequence([{ http: 200, body: {} }]);
    const result = await probeNetwork(fetchImpl, '', 'mainnet');
    expect(result.kind).toBe('retry');
  });
});

describe('ConnectionMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function monitor(fetchImpl: ReturnType<typeof fetchSequence>, buildNetwork: '' | 'testnet' | 'mainnet' = 'mainnet') {
    return new ConnectionMonitor({ fetchImpl, baseUrl: '', buildNetwork });
  }

  it('reaches ready and keeps re-confirming the network', async () => {
    const m = monitor(fetchSequence([{ kind: 'ready', network: 'mainnet' }]));
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.getState()).toEqual({ kind: 'ready', network: 'mainnet' });

    const states: string[] = [];
    m.subscribe((s) => states.push(s.kind));
    await vi.advanceTimersByTimeAsync(RECHECK_READY_MS);
    expect(states).toContain('ready');
  });

  it('keeps connecting through a cold start and flags slow after repeated failures', async () => {
    const m = monitor(fetchSequence([{ throw: true }]));
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.getState().kind).toBe('connecting');

    // Advance past enough backoff cycles to cross the slow threshold.
    for (let i = 0; i < SLOW_AFTER_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(retryDelayMs(i + 1));
    }
    const state = m.getState();
    expect(state.kind).toBe('connecting');
    expect(state.kind === 'connecting' && state.slow).toBe(true);
  });

  it('recovers to ready when the backend finally answers', async () => {
    const m = monitor(fetchSequence([{ throw: true }, { kind: 'ready', network: 'mainnet' }]));
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.getState().kind).toBe('connecting');
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(m.getState()).toEqual({ kind: 'ready', network: 'mainnet' });
  });

  it('reports a mismatch only on a real disagreement', async () => {
    const m = monitor(fetchSequence([{ kind: 'ready', network: 'testnet' }]), 'mainnet');
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.getState()).toEqual({
      kind: 'mismatch',
      buildNetwork: 'mainnet',
      apiNetwork: 'testnet',
    });
  });

  it('stops probing while paused and resumes on demand', async () => {
    const fetchImpl = fetchSequence([{ throw: true }]);
    const m = monitor(fetchImpl);
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    m.pause();
    const calls = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl.mock.calls.length).toBe(calls);
    m.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls);
  });

  it('retryNow probes immediately', async () => {
    const fetchImpl = fetchSequence([{ throw: true }]);
    const m = monitor(fetchImpl);
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = fetchImpl.mock.calls.length;
    m.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(before);
  });

  it('stays responsive and never errors or mismatches while the API is unavailable', async () => {
    // A genuinely unavailable backend (transport failure) must only ever yield
    // `connecting`: the app keeps rendering and retrying. It must not become a
    // mismatch or a hard error, and payment stays locked.
    const m = monitor(fetchSequence([{ throw: true }]));
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.getState().kind).toBe('connecting');

    m.subscribe((s) => {
      expect(s.kind === 'mismatch').toBe(false);
    });
    // Keep failing across several backoff cycles; still just connecting.
    for (let i = 0; i < SLOW_AFTER_ATTEMPTS + 2; i++) {
      await vi.advanceTimersByTimeAsync(retryDelayMs(i + 1));
      expect(m.getState().kind).toBe('connecting');
    }
  });

  it('recovers automatically, without a reload, once the API becomes available', async () => {
    const fetchImpl = fetchSequence([
      { throw: true },
      { http: 502 },
      { kind: 'ready', network: 'mainnet' },
    ]);
    const m = monitor(fetchImpl);
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.getState().kind).toBe('connecting');
    await vi.advanceTimersByTimeAsync(retryDelayMs(1));
    expect(m.getState().kind).toBe('connecting');
    await vi.advanceTimersByTimeAsync(retryDelayMs(2));
    expect(m.getState()).toEqual({ kind: 'ready', network: 'mainnet' });
  });

  it('unsubscribes listeners cleanly', async () => {
    const m = monitor(fetchSequence([{ kind: 'ready', network: 'mainnet' }]));
    const listener = vi.fn();
    const unsubscribe = m.subscribe(listener);
    unsubscribe();
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
