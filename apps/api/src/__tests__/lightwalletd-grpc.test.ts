/**
 * Integration test: a real gRPC round trip against a local lightwalletd-shaped
 * server built from the same vendored proto the provider uses.
 *
 * Unlike the unit tests, nothing here is injected past the gRPC boundary: the
 * provider loads the prototype, opens a real channel, and calls the real
 * methods. This is what proves the client wiring (package path, method names,
 * little-endian txid handling) is correct.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LightwalletdProvider } from '../services/verification-provider.js';
import type { ZcashEngine } from '../services/zcash-engine.js';

const PROTO_PATH = fileURLToPath(new URL('../../proto/service.proto', import.meta.url));
const CLAIMED_TXID = 'a'.repeat(64);

/** A stub engine: the authoritative decode itself is covered by the Rust tests. */
const engine: ZcashEngine = {
  configured: true,
  async inspectAddress() {
    throw new Error('not used');
  },
  async buildUri() {
    throw new Error('not used');
  },
  async decodeTransaction() {
    return { value: { txid: CLAIMED_TXID, size: 1 }, authoritative: true };
  },
  async inspectTransaction() {
    return {
      value: {
        txid: CLAIMED_TXID,
        size: 4,
        pools: { transparent: false, sapling: true, orchard: false, shielded: true },
        recipientHasTransparent: false,
        recipientHasShielded: true,
        transparentRecipientZatoshis: null,
      },
      authoritative: true,
    };
  },
};

function loadServiceDefinition(): grpc.ServiceDefinition {
  const pkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [path.dirname(PROTO_PATH)],
    }),
  ) as unknown as {
    cash: {
      z: { wallet: { sdk: { rpc: { CompactTxStreamer: { service: grpc.ServiceDefinition } } } } };
    };
  };
  return pkg.cash.z.wallet.sdk.rpc.CompactTxStreamer.service;
}

let server: grpc.Server;
let port: number;
const seenHashes: Buffer[] = [];

beforeAll(async () => {
  server = new grpc.Server();
  server.addService(loadServiceDefinition(), {
    GetLightdInfo: (_call: unknown, cb: (e: null, r: unknown) => void) =>
      cb(null, { chainName: 'test', blockHeight: '1000' }),
    GetLatestBlock: (_call: unknown, cb: (e: null, r: unknown) => void) =>
      cb(null, { height: '1000' }),
    GetTransaction: (call: { request: { hash: Buffer } }, cb: (e: null, r: unknown) => void) => {
      seenHashes.push(Buffer.from(call.request.hash));
      cb(null, { data: Uint8Array.from([1, 2, 3, 4]), height: '990' });
    },
  } as unknown as grpc.UntypedServiceImplementation);

  port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => {
      if (err) reject(err);
      else resolve(p);
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
});

describe('LightwalletdProvider over a real gRPC channel', () => {
  it('completes the round trip and computes confirmations from the tip', async () => {
    const provider = new LightwalletdProvider({
      url: `127.0.0.1:${port}`,
      network: 'testnet',
      engine,
    });

    const obs = await provider.observe({ claimedTxid: CLAIMED_TXID, network: 'testnet' });

    expect(obs).not.toBeNull();
    expect(obs!.txid).toBe(CLAIMED_TXID);
    expect(obs!.confirmations).toBe(11); // tip 1000 - mined 990 + 1
    expect(obs!.blockHeight).toBe(990);

    // The server must have received the txid in little-endian byte order.
    expect(seenHashes.length).toBeGreaterThan(0);
    expect(Buffer.from(seenHashes[0]!).reverse().toString('hex')).toBe(CLAIMED_TXID);
  });
});
