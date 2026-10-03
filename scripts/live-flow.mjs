/**
 * Live BLINK end-to-end verification flow against REAL Zcash testnet.
 *
 * It uses a real transaction already mined on testnet and its own transparent
 * recipient address (recovered from the transaction's scriptPubKey), so the
 * payment request and the observed transaction genuinely share an address.
 *
 * It drives the actual HTTP API and shows only the states the verification
 * system actually returns. Nothing is fabricated and no DB field is forced.
 *
 * Usage: node scripts/live-flow.mjs
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createHash } from 'node:crypto';

const API = process.env.BLINK_API_URL ?? 'http://127.0.0.1:4000';
const LWD = process.env.BLINK_LIGHTWALLETD_URL;
if (!LWD) throw new Error('BLINK_LIGHTWALLETD_URL not set');

const def = protoLoader.loadSync('apps/api/proto/service.proto', {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: ['apps/api/proto'],
});
const Ctor = grpc.loadPackageDefinition(def).cash.z.wallet.sdk.rpc.CompactTxStreamer;
const client = new Ctor(LWD.replace(/^https?:\/\//, ''), grpc.credentials.createSsl());
const rpc = (m, r) =>
  new Promise((res, rej) => client[m](r, { deadline: Date.now() + 15000 }, (e, x) => (e ? rej(e) : res(x))));

// --- base58check for transparent testnet addresses ---
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) if (b === 0) out = '1' + out;
  return out;
}
function b58check(version, hash20) {
  const payload = Buffer.concat([Buffer.from([version >> 8, version & 0xff]), hash20]);
  const checksum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  return b58(Buffer.concat([payload, checksum]));
}
function addressFromScript(script) {
  // P2PKH: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return { kind: 'P2PKH', addr: b58check(0x1d25, script.subarray(3, 23)), value: null };
  }
  // P2SH: OP_HASH160 <20> OP_EQUAL
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return { kind: 'P2SH', addr: b58check(0x1cba, script.subarray(2, 22)), value: null };
  }
  return null;
}

const api = async (method, path, body, headers = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

try {
  const tip = Number((await rpc('GetLatestBlock', {})).height);
  console.log('testnet tip:', tip);

  // Find a recent block whose last tx pays a transparent address.
  const offset = Number(process.env.BLINK_BLOCK_OFFSET ?? 2);
  let pick = null;
  for (let h = tip - offset; h > tip - 40 && !pick; h--) {
    const block = await rpc('GetBlock', { height: h });
    for (const tx of block.vtx || []) {
      for (const out of tx.vout || []) {
        const a = out.scriptPubKey ? addressFromScript(Buffer.from(out.scriptPubKey)) : null;
        if (a) { pick = { height: h, txid: Buffer.from(tx.txid).reverse().toString('hex'), addr: a.addr, kind: a.kind, value: out.value }; break; }
      }
      if (pick) break;
    }
  }
  if (!pick) throw new Error('no transparent output found in range');
  console.log('real on-chain tx:', JSON.stringify({ height: pick.height, txid: pick.txid, address: pick.addr, kind: pick.kind }));

  // 1. Create a real payment request to that (real) address.
  const created = await api('POST', '/v1/payment-requests', {
    recipientName: 'Live Testnet Recipient',
    recipientAddress: pick.addr,
    amount: '0.001',
    currency: 'ZEC',
    expiryMinutes: 60,
  });
  if (created.status !== 201 && created.status !== 200) throw new Error('create failed: ' + JSON.stringify(created));
  const sc = created.json.request.shortCode;
  console.log('1. CREATE           -> status', created.json.request.status, '| shortCode', sc);
  console.log('   request keys     ->', Object.keys(created.json.request).join(','));

  // 2. Report the real txid.
  const claim = await api('POST', `/v1/payment-requests/${sc}/transactions`, { txid: pick.txid });
  console.log('2. CLAIM TXID       -> HTTP', claim.status, '| status', claim.json.request.status);

  // 3. Verify against real lightwalletd.
  const v1 = await api('POST', `/v1/payment-requests/${sc}/verify`);
  console.log('3. VERIFY (1) raw   ->', JSON.stringify(v1.json).slice(0, 400));
  if (!v1.json.verification) throw new Error('no verification in response');
  console.log('3. VERIFY (1)       -> observed', v1.json.verification.observed, '| confirmations', v1.json.verification.confirmations, '| status', v1.json.verification.status);

  // 4. Wait for more confirmations and re-verify until CONFIRMED (or timeout).
  let last = v1.json;
  const required = Number(process.env.BLINK_CONFIRMATIONS_REQUIRED ?? 1);
  const deadline = Date.now() + 8 * 60 * 1000;
  while (last.verification.status !== 'CONFIRMED' && Date.now() < deadline) {
    process.stdout.write(`   waiting for confirmations (need ${required})... `);
    await new Promise((r) => setTimeout(r, 20000));
    const v = await api('POST', `/v1/payment-requests/${sc}/verify`);
    last = v.json;
    console.log('observed', last.verification.observed, '| confirmations', last.verification.confirmations, '| status', last.verification.status);
  }

  // 5. Receipt, only if confirmed.
  const receipt = await api('GET', `/v1/payment-requests/${sc}/receipt`);
  console.log('5. RECEIPT          -> HTTP', receipt.status, '|', JSON.stringify(receipt.json).slice(0, 220));

  console.log('\nFINAL STATE:', last.request.status, '| confirmations:', last.request.confirmations);
} finally {
  client.close();
}
