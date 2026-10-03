/**
 * Unit tests for the real lightwalletd verification provider.
 *
 * These test the provider's decision logic against an injected gRPC transport
 * and an injected authoritative-decoder stub. No real network is contacted, but
 * the code path under test is the production one: the provider still has to pass
 * the network check, the chain-name check, the tip/mined-height confirmation
 * arithmetic, and the txid/bytes binding before it will report anything.
 *
 * The overriding property, asserted throughout, is that the provider never
 * invents an observation. Every failure mode must yield `null`.
 */
import { describe, expect, it } from 'vitest';
import type * as grpc from '@grpc/grpc-js';

import {
  LightwalletdProvider,
  type LightwalletdClientFactory,
} from '../services/verification-provider.js';
import type { TransactionInfo, ZcashEngine } from '../services/zcash-engine.js';

const CLAIMED_TXID = 'a'.repeat(64);

interface Calls {
  getTransactionHash?: Buffer;
  closed: boolean;
}

function fakeEngine(overrides: Partial<{
  configured: boolean;
  txid: string | null;
  throwing: boolean;
}> = {}): ZcashEngine {
  const configured = overrides.configured ?? true;
  const txid = overrides.txid === undefined ? CLAIMED_TXID : overrides.txid;
  const throwing = overrides.throwing ?? false;
  return {
    configured,
    async inspectAddress() {
      throw new Error('not used');
    },
    async buildUri() {
      throw new Error('not used');
    },
    async decodeTransaction() {
      if (throwing) throw new Error('decode failed');
      if (txid === null) throw new Error('decode failed');
      const value: TransactionInfo = { txid, size: 2005 };
      return { value, authoritative: true };
    },
  };
}

/** Build a client factory that answers the three RPCs from canned data. */
function fakeClientFactory(config: {
  chainName?: string;
  tipHeight?: number;
  data?: Uint8Array | null;
  minedHeight?: string | number;
  failWith?: Error;
  calls: Calls;
}): LightwalletdClientFactory {
  return () =>
    ({
      close() {
        config.calls.closed = true;
      },
      GetLightdInfo(
        _req: unknown,
        _opt: grpc.CallOptions,
        cb: (e: grpc.ServiceError | null, r: unknown) => void,
      ) {
        if (config.failWith) return void cb(config.failWith, null);
        cb(null, { chainName: config.chainName ?? 'test' });
        return {} as grpc.ClientUnaryCall;
      },
      GetLatestBlock(
        _req: unknown,
        _opt: grpc.CallOptions,
        cb: (e: grpc.ServiceError | null, r: unknown) => void,
      ) {
        if (config.failWith) return void cb(config.failWith, null);
        cb(null, { height: String(config.tipHeight ?? 1000) });
        return {} as grpc.ClientUnaryCall;
      },
      GetTransaction(
        req: { hash: Buffer },
        _opt: grpc.CallOptions,
        cb: (e: grpc.ServiceError | null, r: unknown) => void,
      ) {
        config.calls.getTransactionHash = req.hash;
        if (config.failWith) return void cb(config.failWith, null);
        cb(null, {
          data: config.data ?? null,
          height: String(config.minedHeight ?? 0),
        });
        return {} as grpc.ClientUnaryCall;
      },
    }) as never;
}

function providerWith(config: {
  engine?: ZcashEngine;
  chainName?: string;
  tipHeight?: number;
  data?: Uint8Array | null;
  minedHeight?: string | number;
  failWith?: Error;
  calls: Calls;
  network?: 'testnet' | 'mainnet';
}): LightwalletdProvider {
  return new LightwalletdProvider({
    url: 'http://localhost:9067',
    network: config.network ?? 'testnet',
    engine: config.engine ?? fakeEngine(),
    clientFactory: fakeClientFactory(config),
  });
}

const bytes = Uint8Array.from([1, 2, 3, 4]);

describe('LightwalletdProvider', () => {
  it('reports a confirmation only for a matching, mined transaction on the right network', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({
      calls,
      data: bytes,
      minedHeight: 990,
      tipHeight: 1000,
    });

    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).not.toBeNull();
    expect(obs!.txid).toBe(CLAIMED_TXID);
    expect(obs!.confirmations).toBe(11); // 1000 - 990 + 1
    expect(obs!.blockHeight).toBe(990);
    expect(obs!.broadcast).toBe(true);
    expect(obs!.source).toBe('lightwalletd');
    expect(calls.closed).toBe(true);
  });

  it('sends the txid to lightwalletd in little-endian byte order', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({ calls, data: bytes, minedHeight: 990, tipHeight: 1000 });
    await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(calls.getTransactionHash).toBeDefined();
    // Reversing the little-endian bytes must recover the claimed big-endian txid.
    expect(Buffer.from(calls.getTransactionHash!).reverse().toString('hex')).toBe(CLAIMED_TXID);
  });

  it('reports a broadcast-but-unmined transaction with zero confirmations', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({ calls, data: bytes, minedHeight: 0, tipHeight: 1000 });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).not.toBeNull();
    expect(obs!.confirmations).toBe(0);
    expect(obs!.broadcast).toBe(true);
    expect(obs!.blockHeight).toBeUndefined();
  });

  it('treats the off-chain sentinel height as unconfirmed', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({
      calls,
      data: bytes,
      // 0xffffffffffffffff as protobuf uint64.
      minedHeight: "18446744073709551615",
      tipHeight: 1000,
    });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).not.toBeNull();
    expect(obs!.confirmations).toBe(0);
    expect(obs!.blockHeight).toBeUndefined();
  });

  it('refuses to observe when the endpoint serves a different network', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({ calls, chainName: 'main', data: bytes, tipHeight: 1000 });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).toBeNull();
  });

  it('refuses to observe on a network mismatch before contacting the endpoint', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({ calls, data: bytes, network: 'testnet' });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'mainnet' });
    expect(obs).toBeNull();
    expect(calls.getTransactionHash).toBeUndefined();
  });

  it('refuses when the decoded txid does not match the claim', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({
      calls,
      data: bytes,
      minedHeight: 990,
      tipHeight: 1000,
      engine: fakeEngine({ txid: 'c'.repeat(64) }),
    });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).toBeNull();
  });

  it('never observes without an authoritative decoder configured', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({
      calls,
      data: bytes,
      minedHeight: 990,
      tipHeight: 1000,
      engine: fakeEngine({ configured: false }),
    });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).toBeNull();
  });

  it('reports nothing when lightwalletd returns no transaction data', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({ calls, data: null, tipHeight: 1000 });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).toBeNull();
  });

  it('reports nothing when a gRPC call fails', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({ calls, failWith: new Error('gRPC unavailable') });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).toBeNull();
    expect(calls.closed).toBe(true);
  });

  it('rejects a malformed claimed txid without calling the endpoint', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({ calls, data: bytes, tipHeight: 1000 });
    const obs = await provider.observe({ claimedTxid: 'not-a-txid', network: 'testnet' });
    expect(obs).toBeNull();
    expect(calls.getTransactionHash).toBeUndefined();
  });

  it('reports nothing when the authoritative decoder throws', async () => {
    const calls: Calls = { closed: false };
    const provider = providerWith({
      calls,
      data: bytes,
      minedHeight: 990,
      tipHeight: 1000,
      engine: fakeEngine({ throwing: true }),
    });
    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });
    expect(obs).toBeNull();
  });
});
