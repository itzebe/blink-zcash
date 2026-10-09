/**
 * Unified Address receiver inspection (ZIP 316).
 *
 * A Unified Address string is not self-describing: the same `u…` prefix can hide
 * a Sapling receiver, an Orchard receiver, a transparent receiver, or any
 * combination. Treating every UA as "shielded" would over-claim privacy — a
 * wallet handed a UA that exposes only a transparent receiver can (and typically
 * will) settle into that transparent receiver, leaking the recipient and amount
 * on-chain.
 *
 * This module unwraps a UA to its raw, un-jumbled item list using the ZIP 316
 * `F4Jumble` transform, and reports which receiver pools it actually contains.
 *
 * It deliberately does NOT implement the cryptography of shielded pools: it only
 * decodes a public container encoding. The authoritative check still lives in the
 * Rust `blink-zcash` engine; this is the honest fallback used when the engine is
 * not configured, and it matches the engine's receiver composition exactly.
 */
import { blake2b } from '@noble/hashes/blake2b';

/** Typecodes defined by ZIP 316. */
const TYPECODE_P2PKH = 0x00;
const TYPECODE_P2SH = 0x01;
const TYPECODE_SAPLING = 0x02;
const TYPECODE_ORCHARD = 0x03;

/** F4Jumble personalization, exactly as in `f4jumble` (ZIP 316). */
const H_PERS = (i: number): Uint8Array => {
  const p = new Uint8Array(16);
  p.set([85, 65, 95, 70, 52, 74, 117, 109, 98, 108, 101, 95, 72, i, 0, 0]);
  return p;
};
const G_PERS = (i: number, j: number): Uint8Array => {
  const p = new Uint8Array(16);
  p.set([85, 65, 95, 70, 52, 74, 117, 109, 98, 108, 101, 95, 71, i, j & 0xff, (j >> 8) & 0xff]);
  return p;
};

function xorInPlace(target: Uint8Array, source: Uint8Array): void {
  const n = Math.min(target.length, source.length);
  for (let i = 0; i < n; i++) target[i] = (target[i]! ^ source[i]!) & 0xff;
}

function blake(bits: number, personal: Uint8Array, data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: bits / 8, personalization: personal });
}

function hRound(left: Uint8Array, right: Uint8Array, i: number): void {
  const hash = blake(left.length * 8, H_PERS(i), right);
  xorInPlace(left, hash);
}

function gRound(left: Uint8Array, right: Uint8Array, i: number): void {
  const chunks = Math.ceil(right.length / 64);
  for (let j = 0; j < chunks; j++) {
    const hash = blake(512, G_PERS(i, j), left);
    const start = j * 64;
    const end = Math.min(start + 64, right.length);
    for (let k = start; k < end; k++) right[k] = (right[k]! ^ hash[k - start]!) & 0xff;
  }
}

/** Inverse of the ZIP 316 `F4Jumble` transform, in place. */
export function f4jumbleInvMut(message: Uint8Array): void {
  const msgLen = message.length;
  if (msgLen < 48 || msgLen > 4194368) {
    throw new Error('f4jumble: message length out of range');
  }
  const leftLen = Math.min(64, Math.floor(msgLen / 2));
  const left = message.subarray(0, leftLen);
  const right = message.subarray(leftLen);
  // apply_f4jumble_inv: h(1), g(1), h(0), g(0)
  hRound(left, right, 1);
  gRound(left, right, 1);
  hRound(left, right, 0);
  gRound(left, right, 0);
}

export interface UnifiedReceiversDecoded {
  transparent: boolean;
  sapling: boolean;
  orchard: boolean;
  /** A receiver of a typecode this build does not recognise is present. */
  unknown: boolean;
}

/** Read a Bitcoin/Zcash CompactSize integer. Returns [value, newOffset]. */
function readCompactSize(data: Uint8Array, offset: number): [number, number] {
  if (offset >= data.length) throw new Error('f4jumble: truncated CompactSize');
  const first = data[offset]!;
  if (first < 0xfd) return [first, offset + 1];
  if (first === 0xfd) return [data[offset + 1]! | (data[offset + 2]! << 8), offset + 3];
  if (first === 0xfe) {
    const v =
      data[offset + 1]! |
      (data[offset + 2]! << 8) |
      (data[offset + 3]! << 16) |
      (data[offset + 4]! << 24);
    return [v >>> 0, offset + 5];
  }
  throw new Error('f4jumble: CompactSize too large');
}

/**
 * Decode the receiver pools of a Unified Address from its already-decoded Bech32m
 * data payload. The payload is the F4Jumbled item stream (without the Bech32m
 * checksum, since the HRP length varies and depends on it).
 */
export function decodeUnifiedReceivers(unjumbled: Uint8Array, hrp: string): UnifiedReceiversDecoded {
  const result: UnifiedReceiversDecoded = {
    transparent: false,
    sapling: false,
    orchard: false,
    unknown: false,
  };
  // The raw item stream is followed by a 16-byte padding block: the HRP bytes
  // zero-padded to 16. ZIP 316 does not require the total to be 16-byte aligned,
  // so strip exactly the trailing 16 bytes.
  let end = unjumbled.length;
  const padLen = 16;
  if (end < padLen + 2) throw new Error('f4jumble: payload too short');
  const padding = unjumbled.subarray(end - padLen, end);
  for (let i = 0; i < hrp.length; i++) {
    if (padding[i] !== hrp.charCodeAt(i)) throw new Error('f4jumble: bad padding');
  }
  for (let i = hrp.length; i < padLen; i++) {
    if (padding[i] !== 0) throw new Error('f4jumble: bad padding');
  }
  end -= padLen;

  let offset = 0;
  while (offset < end) {
    const [typecode, afterTypecode] = readCompactSize(unjumbled, offset);
    const [length, afterLength] = readCompactSize(unjumbled, afterTypecode);
    const dataEnd = afterLength + length;
    if (dataEnd > end) throw new Error('f4jumble: item overruns payload');
    switch (typecode) {
      case TYPECODE_P2PKH:
      case TYPECODE_P2SH:
        result.transparent = true;
        break;
      case TYPECODE_SAPLING:
        result.sapling = true;
        break;
      case TYPECODE_ORCHARD:
        result.orchard = true;
        break;
      default:
        // 0xc0..0xfc are metadata items, not receivers. Anything else is a
        // receiver type this build does not know.
        if (typecode < 0xc0) result.unknown = true;
        break;
    }
    offset = dataEnd;
  }
  return result;
}
