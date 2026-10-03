/**
 * Live testnet proof for the REAL LightwalletdProvider.
 *
 * It does not fabricate anything:
 *   1. asks the real testnet lightwalletd for block data,
 *   2. extracts a real transaction id that is mined on testnet,
 *   3. runs that txid through the actual production `LightwalletdProvider`
 *      (the same class used by the API) with the real Rust engine wired in,
 *   4. prints the provider's observation (or null), unmodified.
 *
 * Usage: node scripts/live-testnet-proof.mjs <height-offset>
 */
import { LightwalletdProvider } from '../apps/api/dist/services/verification-provider.js';
import { createZcashEngine } from '../apps/api/dist/services/zcash-engine.js';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';

const URL = process.env.BLINK_LIGHTWALLETD_URL;
const ENGINE_URL = process.env.BLINK_ZCASH_SERVICE_URL;
if (!URL) throw new Error('BLINK_LIGHTWALLETD_URL is not set');

const PROTO = path.resolve('apps/api/proto/service.proto');
const def = protoLoader.loadSync(PROTO, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.dirname(PROTO)],
});
const Ctor = grpc.loadPackageDefinition(def).cash.z.wallet.sdk.rpc.CompactTxStreamer;
const client = new Ctor(URL.replace(/^https?:\/\//, ''), grpc.credentials.createSsl());
const call = (m, req) =>
  new Promise((res, rej) =>
    client[m](req, { deadline: Date.now() + 15000 }, (e, r) => (e ? rej(e) : res(r))),
  );

try {
  const tip = Number((await call('GetLatestBlock', {})).height);
  console.log('testnet tip height:', tip);

  // Walk back a few blocks until one contains at least one transaction.
  let found = null;
  for (let h = tip - Number(process.argv[2] ?? 5); h > tip - 60 && !found; h--) {
    const block = await call('GetBlock', { height: h });
    const vtx = block.vtx || [];
    if (vtx.length > 0) {
      const tx = vtx[vtx.length - 1];
      const txidBE = Buffer.from(tx.txid).reverse().toString('hex'); // protocol LE -> textual BE
      const txidLE = Buffer.from(tx.txid).toString('hex');
      found = { height: h, txidBE, txidLE, count: vtx.length };
    }
  }
  if (!found) throw new Error('no block with transactions found in range');
  console.log('real mined tx:', JSON.stringify({ height: found.height, txid: found.txidBE }, null, 0));

  // Now run it through the REAL provider.
  const engine = createZcashEngine(ENGINE_URL);
  const provider = new LightwalletdProvider({
    url: URL,
    network: 'testnet',
    timeoutMs: 15000,
    engine,
  });

  const observed = await provider.observe({ claimedTxid: found.txidBE, network: 'testnet' });
  console.log('REAL provider.observe() =>', observed ? JSON.stringify(observed, null, 1) : 'null');

  // Negative controls: must never confirm.
  const wrongTxid = found.txidBE.replace(/^../, 'ff');
  const mismatch = await provider.observe({ claimedTxid: wrongTxid, network: 'testnet' });
  console.log('mismatched txid =>', mismatch ? 'OBSERVED (!!)' : 'null (correctly rejected)');
  const wrongNet = await provider.observe({ claimedTxid: found.txidBE, network: 'mainnet' });
  console.log('wrong network =>', wrongNet ? 'OBSERVED (!!)' : 'null (correctly rejected)');
} finally {
  client.close();
}
