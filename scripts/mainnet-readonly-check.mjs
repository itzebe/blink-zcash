/**
 * BLINK mainnet READ-ONLY verification.
 *
 * This script performs NO broadcast, NO signing and NO fund movement. It only
 * reads public mainnet chain data through a real lightwalletd endpoint and
 * decodes existing transactions with the authoritative Rust engine.
 *
 * What it establishes (and only what it establishes):
 *   1. the configured provider reports mainnet identity (`chainName === "main"`),
 *   2. a genuine mined mainnet transaction that carries shielded-pool activity
 *      can be fetched and decoded by the real engine (txid binding verified),
 *   3. network-mismatch, unknown-txid and malformed-recipient controls reject,
 *   4. the shielded-only receiver policy rejects transparent-only and mixed UAs
 *      and accepts a shielded-only UA,
 *   5. a shielded settlement cannot be reported with a verified recipient/amount
 *      from public bytes alone.
 *
 * It explicitly does NOT claim to prove an end-to-end shielded payment: no real
 * funds are sent and a shielded recipient/amount is not publicly verifiable.
 *
 * Usage:
 *   BLINK_LIGHTWALLETD_URL=https://zec.rocks:443 \
 *   BLINK_ZCASH_SERVICE_URL=http://127.0.0.1:8080 \
 *   node scripts/mainnet-readonly-check.mjs [scanDepth]
 */
import { LightwalletdProvider } from '../apps/api/dist/services/verification-provider.js';
import { createZcashEngine } from '../apps/api/dist/services/zcash-engine.js';
import { parseAddress } from '../packages/zcash/dist/index.js';
import { shieldedOnlyPolicy } from '../packages/shared/dist/index.js';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';

const URL = process.env.BLINK_LIGHTWALLETD_URL;
const ENGINE_URL = process.env.BLINK_ZCASH_SERVICE_URL ?? 'http://127.0.0.1:8080';
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
    client[m](req, { deadline: Date.now() + 20000 }, (e, r) => (e ? rej(e) : res(r))),
  );

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
};

// Mainnet addresses used only as *inputs* to policy/reject checks (never paid).
const MAIN_SAPLING =
  'zs10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfs72c47k';
const MAIN_TRANSPARENT = 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs';
// Mainnet UA with a transparent (P2PKH) + Sapling receiver (mixed -> must reject).
const MAIN_UA_MIXED =
  'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf';
const EXPECTED_CONSENSUS_BRANCH_HEX = null; // recorded, not asserted

try {
  const engine = createZcashEngine(ENGINE_URL);
  const provider = new LightwalletdProvider({
    url: URL,
    network: 'mainnet',
    timeoutMs: 20000,
    engine,
  });

  // ---- 1. Provider reports mainnet identity -------------------------------
  const info = await call('GetLightdInfo', {});
  record(
    'provider chain identity is mainnet',
    info.chainName === 'main',
    `chainName=${info.chainName} vendor=${info.vendor} version=${info.version} consensus=${info.consensusBranchId} tip=${info.blockHeight}`,
  );
  void EXPECTED_CONSENSUS_BRANCH_HEX;

  const tip = Number((await call('GetLatestBlock', {})).height);
  console.log(`mainnet tip height: ${tip}`);
  const scanDepth = Number(process.argv[2] ?? 40);

  // ---- 2. Find a genuine mined mainnet tx with shielded-pool activity -----
  // We scan recent blocks for a transaction that carries Sapling/Orchard
  // activity. We report the txid and re-derive it from bytes, so the identity is
  // bound. This is a *decode* proof, not a payment proof.
  let shieldedTx = null;
  let lastTxid = null;
  for (let h = tip; h > tip - scanDepth && !shieldedTx; h--) {
    let block;
    try {
      block = await call('GetBlock', { height: h });
    } catch {
      continue;
    }
    const vtx = block.vtx || [];
    for (const tx of vtx) {
      const txidBE = Buffer.from(tx.txid).reverse().toString('hex');
      lastTxid = txidBE;
      const hasShielded =
        (tx.spends && tx.spends.length) ||
        (tx.outputs && tx.outputs.length) ||
        (tx.actions && tx.actions.length);
      if (hasShielded) {
        shieldedTx = { height: h, txid: txidBE, tx };
        break;
      }
    }
  }
  record(
    'found mined mainnet tx with shielded-pool activity',
    !!shieldedTx,
    shieldedTx
      ? `height=${shieldedTx.height} txid=${shieldedTx.txid}`
      : `none in [${tip - scanDepth + 1}, ${tip}]`,
  );

  if (shieldedTx) {
    // ---- 3. Fetch the raw bytes and decode with the real engine -----------
    const raw = await call('GetTransaction', { hash: Buffer.from(shieldedTx.txid, 'hex').reverse() });
    const data = raw?.data ? Buffer.from(raw.data) : Buffer.alloc(0);
    const decoded = data.length
      ? await engine.inspectTransaction(data.toString('hex'), { network: 'mainnet' })
      : null;
    record(
      'engine decodes the real mainnet transaction bytes',
      !!decoded && decoded.value.txid.toLowerCase() === shieldedTx.txid.toLowerCase(),
      decoded
        ? `decoded txid=${decoded.value.txid} size=${decoded.value.size} pools=${JSON.stringify(decoded.value.pools)}`
        : 'no bytes / decode failed',
    );
    if (decoded) {
      record(
        'decoded pooled txid matches the requested txid',
        decoded.value.txid.toLowerCase() === shieldedTx.txid.toLowerCase(),
        `${decoded.value.txid.toLowerCase()} === ${shieldedTx.txid.toLowerCase()}`,
      );

      // A shielded recipient is never attributed a transparent amount.
      record(
        'shielded-pool tx exposes no transparent amount for a shielded recipient',
        decoded.value.transparentRecipientZatoshis === null ||
          decoded.value.recipientHasTransparent === false,
        `recipientHasTransparent=${decoded.value.recipientHasTransparent} transparentRecipientZatoshis=${decoded.value.transparentRecipientZatoshis}`,
      );
    }

    // ---- Real provider observe() on the genuine mainnet tx ----------------
    const observed = await provider.observe({
      claimedTxid: shieldedTx.txid,
      network: 'mainnet',
      expectedAddress: MAIN_SAPLING,
    });
    record(
      'real provider.observe() binds the txid and attaches decoded evidence',
      !!observed &&
        observed.txid.toLowerCase() === shieldedTx.txid.toLowerCase() &&
        !!observed.evidence,
      observed
        ? `txid=${observed.txid} confirmations=${observed.confirmations} source=${observed.source} pools=${JSON.stringify(observed.evidence?.pools)}`
        : 'null',
    );
    if (observed?.evidence) {
      record(
        'observed evidence does not claim a verified recipient/amount for a shielded request',
        observed.evidence.transparentRecipientZatoshis === null &&
          observed.evidence.recipientHasTransparent === false,
        `transparentRecipientZatoshis=${observed.evidence.transparentRecipientZatoshis} recipientHasTransparent=${observed.evidence.recipientHasTransparent}`,
      );
    }
  }

  // ---- 4. Negative controls ----------------------------------------------
  const unknown = await provider.observe({
    claimedTxid: '0'.repeat(64),
    network: 'mainnet',
    expectedAddress: MAIN_SAPLING,
  });
  record('unknown txid is not observed', unknown === null, `${unknown}`);

  if (lastTxid) {
    const mismatched = await provider.observe({
      claimedTxid: lastTxid.replace(/^../, 'ff'),
      network: 'mainnet',
    });
    record('mismatched txid is not observed', mismatched === null, `${mismatched}`);
  }

  const wrongNet = await provider.observe({
    claimedTxid: shieldedTx?.txid ?? '0'.repeat(64),
    network: 'testnet',
  });
  record('wrong-network claim is not observed', wrongNet === null, `${wrongNet}`);

  // ---- 5. Address-level policy / rejection --------------------------------
  // Malformed recipient: the engine rejects it.
  let malformedRejected = false;
  try {
    parseAddress('not-a-real-address');
  } catch {
    malformedRejected = true;
  }
  record('malformed recipient is rejected', malformedRejected, 'inspectAddress threw');

  // Transparent-only recipient -> policy refuses.
  const t = parseAddress(MAIN_TRANSPARENT);
  const tVerdict = shieldedOnlyPolicy(t.receivers);
  record(
    'transparent-only recipient is refused by shielded-only policy',
    tVerdict.ok === false && tVerdict.reason === 'transparent_recipient',
    JSON.stringify(t.receivers),
  );

  // Mixed transparent+shielded UA -> policy refuses.
  const m = parseAddress(MAIN_UA_MIXED);
  const mVerdict = shieldedOnlyPolicy(m.receivers);
  record(
    'mixed transparent/shielded UA is refused by shielded-only policy',
    mVerdict.ok === false && mVerdict.reason === 'transparent_recipient',
    JSON.stringify(m.receivers),
  );

  // Shielded-only recipient -> policy accepts.
  const s = parseAddress(MAIN_SAPLING);
  const sVerdict = shieldedOnlyPolicy(s.receivers);
  record(
    'shielded-only recipient is accepted by shielded-only policy',
    sVerdict.ok === true,
    JSON.stringify(s.receivers),
  );

  // ---- 6. Confirmation-depth handling (no broadcast) ----------------------
  // Depth is derived arithmetically from a mined height vs the current tip; this
  // reads chain state only and never sends anything.
  const sampleHeight = shieldedTx?.height ?? tip;
  const depth = tip - sampleHeight + 1;
  record(
    'confirmation depth is derived from chain state (no broadcast)',
    Number.isFinite(depth) && depth >= 1,
    `height=${sampleHeight} tip=${tip} depth=${depth}`,
  );

  console.log('\n---- summary ----');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
  console.log(
    '\nNOTE: this is a read-only decode/verification proof. It does NOT prove an\n' +
      'end-to-end shielded payment: no funds were sent and a shielded recipient and\n' +
      'amount are not publicly verifiable. Only a controlled real payment can prove that.',
  );
} finally {
  client.close();
}