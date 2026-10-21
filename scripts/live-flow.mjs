/**
 * Live BLINK end-to-end flow against a REAL Zcash network.
 *
 * The SUPPORTED product flow is shielded-first: a payment request may only name
 * a shielded-only recipient (a Sapling address, or a Unified Address that
 * carries no transparent receiver). This script drives that flow through the
 * real HTTP API and prints ONLY the states the verification system actually
 * returns. Nothing is fabricated and no database field is forced.
 *
 * It never signs, funds, or broadcasts anything. It observes real, already-mined
 * network data. A genuine end-to-end *shielded payment* (a funded wallet paying
 * the request and the recipient viewing key trial-decrypting the note) is a
 * separate release gate that this environment cannot satisfy; see
 * docs/live-testnet-verification.md. This script reports that limitation rather
 * than pretending otherwise.
 *
 * Usage:
 *   BLINK_LIGHTWALLETD_URL=https://<host>:443 node scripts/live-flow.mjs
 *
 * Legacy mode (transparent), retained only to document that the product API now
 * REJECTS a transparent recipient. It is NOT the product flow:
 *   BLINK_LIGHTWALLETD_URL=https://<host>:443 node scripts/live-flow.mjs --legacy-transparent
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createHash } from 'node:crypto';

const API = process.env.BLINK_API_URL ?? 'http://127.0.0.1:4000';
const LWD = process.env.BLINK_LIGHTWALLETD_URL;
if (!LWD) throw new Error('BLINK_LIGHTWALLETD_URL not set');

const NETWORK = (process.env.ZCASH_NETWORK ?? 'testnet').toLowerCase();
const LEGACY_TRANSPARENT = process.argv.includes('--legacy-transparent');

// A shielded-only fixture appropriate to the selected network. The default is a
// well-known Zcash TESTNET Sapling address used across the test suite; it holds
// no value and no key. For mainnet a shielded address MUST be supplied
// explicitly - we never invent one. No viewing key, spending key, or other
// secret is ever read or printed.
const TESTNET_SHIELDED_FIXTURE =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const SHIELDED_RECIPIENT = process.env.BLINK_SHIELDED_ADDRESS
  ?? (NETWORK === 'mainnet' ? '' : TESTNET_SHIELDED_FIXTURE);

const def = protoLoader.loadSync('apps/api/proto/service.proto', {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: ['apps/api/proto'],
});
const Ctor = grpc.loadPackageDefinition(def).cash.z.wallet.sdk.rpc.CompactTxStreamer;
const client = new Ctor(LWD.replace(/^https?:\/\//, ''), grpc.credentials.createSsl());
const rpc = (m, r) =>
  new Promise((res, rej) => client[m](r, { deadline: Date.now() + 15000 }, (e, x) => (e ? rej(e) : res(x))));

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

// --- base58check for transparent addresses (network-aware) ---
// Used ONLY by the legacy transparent mode, to recover a real transparent
// address from a mined transaction's scriptPubKey. The product flow never builds
// or accepts a transparent address.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const P2PKH_VERSION = NETWORK === 'mainnet' ? 0x1cb8 : 0x1d25;
const P2SH_VERSION = NETWORK === 'mainnet' ? 0x1cbd : 0x1cba;
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
  if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return { kind: 'P2PKH', addr: b58check(P2PKH_VERSION, script.subarray(3, 23)) };
  }
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return { kind: 'P2SH', addr: b58check(P2SH_VERSION, script.subarray(2, 22)) };
  }
  return null;
}

/**
 * Scan recent compact blocks for a real mined transaction. `want` selects a
 * transaction with shielded-pool activity (`spends`/`outputs`/`actions`) for the
 * supported flow, or a transparent output for the legacy flow.
 */
async function findMinedTx(want, depth = Number(process.env.BLINK_SCAN_DEPTH ?? 400)) {
  const tip = Number((await rpc('GetLatestBlock', {})).height);
  console.log(NETWORK + ' tip:', tip, '| scanning', depth, 'blocks for', want);
  const offset = Number(process.env.BLINK_BLOCK_OFFSET ?? 2);
  for (let h = tip - offset; h > tip - depth; h--) {
    const block = await rpc('GetBlock', { height: h });
    for (const tx of block.vtx || []) {
      const shieldedActivity =
        (tx.spends && tx.spends.length > 0) ||
        (tx.outputs && tx.outputs.length > 0) ||
        (tx.actions && tx.actions.length > 0);
      const txid = Buffer.from(tx.txid).reverse().toString('hex');
      if (want === 'shielded') {
        if (shieldedActivity) return { height: h, txid, kind: 'shielded' };
      } else {
        for (const out of tx.vout || []) {
          const a = out.scriptPubKey ? addressFromScript(Buffer.from(out.scriptPubKey)) : null;
          if (a) return { height: h, txid, addr: a.addr, kind: a.kind };
        }
      }
    }
  }
  return null;
}

async function legacyTransparentFlow() {
  console.log('\n=== LEGACY TRANSPARENT MODE (NOT the product flow) ===');
  console.log('This mode documents that the shielded-first create flow now REJECTS a');
  console.log('transparent recipient. It does not create a product payment request.\n');

  // A known-valid transparent address for the selected network. It is only used
  // to prove the product API refuses it. For mainnet it MUST be supplied
  // explicitly; we never invent one.
  const transparentRecipient = process.env.BLINK_TRANSPARENT_ADDRESS
    ?? (NETWORK === 'mainnet' ? '' : 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU');
  if (!transparentRecipient) {
    console.log('BLOCKED: set BLINK_TRANSPARENT_ADDRESS to a transparent address for ' + NETWORK + '.');
    return;
  }

  const created = await api('POST', '/v1/payment-requests', {
    recipientName: 'Legacy ' + NETWORK + ' Transparent',
    recipientAddress: transparentRecipient,
    amount: '0.001',
    currency: 'ZEC',
    expiryMinutes: 60,
  });
  console.log('CREATE (transparent) -> HTTP', created.status, '|', JSON.stringify(created.json));
  if (created.status === 400 && created.json?.error === 'transparent_recipient') {
    console.log('EXPECTED: the product API refused a transparent recipient (shielded-first policy).');
  } else {
    console.log('UNEXPECTED: the product API did not reject a transparent recipient.');
  }
}

async function shieldedFlow() {
  if (!SHIELDED_RECIPIENT) {
    console.log('\nBLOCKED: no shielded recipient configured for network "' + NETWORK + '".');
    console.log('Set BLINK_SHIELDED_ADDRESS to a shielded-only address for this network');
    console.log('(a Sapling address, or a Unified Address with no transparent receiver).');
    return;
  }

  const pick = await findMinedTx('shielded');
  if (!pick) {
    console.log('\nNOTE: no mined transaction with shielded-pool activity was found in the');
    console.log('scanned range. Testnet is largely transparent; increase BLINK_SCAN_DEPTH');
    console.log('to widen the search. Falling back to a real transparent transaction, which');
    console.log('still exercises the full create -> claim -> verify path and demonstrates the');
    console.log('honest shielded-first outcome (OBSERVED, never CONFIRMED).');
  } else {
    console.log('real on-chain shielded-activity tx:', JSON.stringify({ height: pick.height, txid: pick.txid }));
  }
  const claimTx = pick ?? (await findMinedTx('transparent'));
  if (!claimTx) throw new Error('no mined transaction found in range (raise BLINK_SCAN_DEPTH)');
  if (!pick) console.log('using real on-chain tx:', JSON.stringify({ height: claimTx.height, txid: claimTx.txid, kind: claimTx.kind }));

  // 1. Create a real payment request to the shielded-only recipient.
  const created = await api('POST', '/v1/payment-requests', {
    recipientName: 'Live ' + NETWORK + ' Shielded Recipient',
    recipientAddress: SHIELDED_RECIPIENT,
    amount: '0.001',
    currency: 'ZEC',
    expiryMinutes: 60,
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error('create failed (expected the address to be accepted): ' + JSON.stringify(created));
  }
  const sc = created.json.request.shortCode;
  console.log('1. CREATE           -> status', created.json.request.status, '| shortCode', sc);
  console.log('   privacy          ->', JSON.stringify(created.json.request.privacy));

  // 2. The ZIP 321 URI a compatible wallet would scan. It is reconstructed from
  //    the encrypted address on demand and never read back from storage.
  const details = await api('GET', `/v1/payment-requests/${sc}/payment-details`);
  console.log('2. PAYMENT DETAILS  -> HTTP', details.status, '| addressKind', details.json.addressKind);
  console.log('   zip321Uri        ->', String(details.json.zip321Uri).slice(0, 80) + '...');

  // 3. Report a real mined txid. This is an UNTRUSTED claim: it does not, by
  //    itself, settle anything.
  const claim = await api('POST', `/v1/payment-requests/${sc}/transactions`, { txid: claimTx.txid });
  console.log('3. CLAIM TXID       -> HTTP', claim.status, '| status', claim.json.request.status);

  // 4. Verify against real lightwalletd. The found transaction is almost
  //    certainly not this request's recipient, so the honest result is a mined
  //    observation without recipient/amount evidence - OBSERVED, never CONFIRMED.
  const required = Number(process.env.BLINK_CONFIRMATIONS_REQUIRED ?? 1);
  let last;
  const deadline = Date.now() + 3 * 60 * 1000;
  for (;;) {
    const v = await api('POST', `/v1/payment-requests/${sc}/verify`);
    if (!v.json.verification) throw new Error('no verification in response: ' + JSON.stringify(v.json));
    last = v.json;
    console.log('4. VERIFY           -> observed', last.verification.observed,
      '| confirmations', last.verification.confirmations,
      '| status', last.verification.status,
      '| shielded', JSON.stringify(last.verification.shielded?.state ?? null));
    if (['OBSERVED', 'CONFIRMED', 'UNKNOWN'].includes(last.verification.status)) break;
    if (Date.now() >= deadline) {
      console.log('   (timed out waiting for depth; reporting the current honest state)');
      break;
    }
    process.stdout.write(`   waiting for confirmations (need ${required})... `);
    await new Promise((r) => setTimeout(r, 20000));
  }

  // 5. Receipt: issued ONLY when the request is CONFIRMED by settlement evidence
  //    (a viewing-key-verified shielded note, or a public transparent match).
  const receipt = await api('GET', `/v1/payment-requests/${sc}/receipt`);
  console.log('5. RECEIPT          -> HTTP', receipt.status, '|', JSON.stringify(receipt.json).slice(0, 200));

  console.log('\nFINAL STATE:', last.request.status, '| confirmations:', last.request.confirmations);
  if (last.request.status === 'OBSERVED') {
    console.log('This is the honest ceiling without a recipient viewing key: the transaction');
    console.log('is observed at depth, but the intended shielded recipient and amount are not');
    console.log('established, so the request is NOT confirmed and no receipt is issued.');
  }
  console.log('A funded shielded-wallet payment plus a recipient viewing key is required to');
  console.log('reach CONFIRMED end to end; that is a separate release gate, not proven here.');
}

try {
  if (LEGACY_TRANSPARENT) {
    await legacyTransparentFlow();
  } else {
    await shieldedFlow();
  }
} finally {
  client.close();
}
