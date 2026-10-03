/**
 * Zcash address parsing and network separation.
 *
 * BLINK supports the address formats that ZIP 321 permits in payment requests:
 *
 *  - transparent P2PKH / P2SH (Base58Check),
 *  - Sapling payment addresses (Bech32, HRP `zs`),
 *  - Unified Addresses (Bech32m, HRP `u`).
 *
 * Sprout addresses are deliberately rejected, as required by ZIP 321.
 *
 * Addresses are validated in two independent layers:
 *
 *  1. A fast structural check in this module (checksum, HRP, network), which
 *     runs in the browser and in the API.
 *  2. An authoritative check against the official Rust `zcash_address` crate
 *     exposed by the `blink-zcash` service. When that service is reachable the
 *     API requires it to agree before a request is accepted.
 *
 * This module never claims to perform cryptography; it only decodes and
 * checksums public address encodings.
 */

import { base58check as scureBase58Check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import type { ZcashNetwork } from '@blink/shared';

export type AddressKind = 'transparent' | 'sapling' | 'unified';

export interface ParsedAddress {
  /** The original address string. */
  address: string;
  kind: AddressKind;
  network: ZcashNetwork;
}

export class InvalidAddressError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'malformed'
      | 'bad_checksum'
      | 'unsupported_sprout'
      | 'unknown_hrp'
      | 'network_mismatch' = 'malformed',
  ) {
    super(message);
    this.name = 'InvalidAddressError';
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Human-readable parts defined by the Zcash protocol specification
// (zcash_protocol::constants::{mainnet,testnet,regtest}).
const SAPLING_HRP: Record<string, ZcashNetwork> = {
  zs: 'mainnet',
  ztestsapling: 'testnet',
  zregtestsapling: 'testnet',
};

const UNIFIED_HRP: Record<string, ZcashNetwork> = {
  u: 'mainnet',
  utest: 'testnet',
  uregtest: 'testnet',
};

/**
 * Transparent address version bytes. Mainnet and testnet use distinct bytes so
 * a testnet address can never be mistaken for a mainnet one.
 */
const TRANSPARENT_VERSIONS: Record<string, { kind: 'p2pkh' | 'p2sh'; network: ZcashNetwork }> = {
  '1cb8': { kind: 'p2pkh', network: 'mainnet' },
  '1cbd': { kind: 'p2sh', network: 'mainnet' },
  '1d25': { kind: 'p2pkh', network: 'testnet' },
  '1cba': { kind: 'p2sh', network: 'testnet' },
};

/**
 * Sprout address version bytes. ZIP 321 requires Sprout addresses to be
 * rejected, so we detect them by their Base58Check version bytes rather than by
 * a string prefix (`zc`/`ztest` also start with `z`).
 */
const SPROUT_VERSIONS = new Set(['169a', '16b6']);

/** Map a bech32/bech32m HRP to a network, rejecting unknown prefixes. */
function networkFromHrp(hrp: string, table: Record<string, ZcashNetwork>): ZcashNetwork | null {
  return table[hrp] ?? null;
}

function decodeBase58Check(address: string): Uint8Array | null {
  if (address.length === 0) return null;
  try {
    return scureBase58Check(sha256).decode(address);
  } catch {
    return null;
  }
}

/**
 * Parse and validate a Zcash address. Throws {@link InvalidAddressError} on any
 * problem; never returns a partially-valid result.
 */
export function parseAddress(address: string): ParsedAddress {
  if (typeof address !== 'string' || address.length === 0) {
    throw new InvalidAddressError('address must be a non-empty string');
  }
  const trimmed = address.trim();
  if (trimmed !== address) {
    throw new InvalidAddressError('address must not contain surrounding whitespace');
  }
  if (trimmed.length > 512) {
    throw new InvalidAddressError('address is implausibly long');
  }

  // Reject Sprout addresses explicitly. They use distinct Base58Check version
  // bytes; detecting them here (rather than by prefix) avoids clashing with
  // `ztest…` shielded addresses.
  const maybeSprout = decodeBase58Check(trimmed);
  if (maybeSprout && maybeSprout.length === 66) {
    const version = bytesToHex(maybeSprout.slice(0, 2));
    if (SPROUT_VERSIONS.has(version)) {
      throw new InvalidAddressError(
        'Sprout addresses are not supported in payment requests (ZIP 321)',
        'unsupported_sprout',
      );
    }
  }

  // Otherwise it must be a bech32/bech32m shielded address or a transparent
  // Base58Check address. Detect the encoding by the HRP of the bech32 checksum
  // rather than by a `u1`/`zs1` string prefix.
  return decodeShieldedOrTransparent(trimmed);
}

function decodeShieldedOrTransparent(address: string): ParsedAddress {
  const lower = address.toLowerCase();

  // Sapling payment addresses use Bech32 with a `zs`-family HRP.
  if (/^z/.test(lower)) {
    const sapling = tryDecodeBech32(address, 'sapling', false, SAPLING_HRP);
    if (sapling) return sapling;
    // Fall through; it may be a transparent address or invalid.
  }

  // Unified Addresses use Bech32m with a `u`-family HRP.
  if (/^u/.test(lower)) {
    const unified = tryDecodeBech32(address, 'unified', true, UNIFIED_HRP);
    if (unified) return unified;
  }

  const decoded = decodeBase58Check(address);
  if (decoded === null || decoded.length !== 22) {
    throw new InvalidAddressError('not a valid Zcash address', 'malformed');
  }
  const version = bytesToHex(decoded.slice(0, 2));
  const info = TRANSPARENT_VERSIONS[version];
  if (!info) {
    throw new InvalidAddressError('unknown transparent address version', 'malformed');
  }
  return { address, kind: 'transparent', network: info.network };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function tryDecodeBech32(
  address: string,
  kind: 'sapling' | 'unified',
  bech32mEncoding: boolean,
  table: Record<string, ZcashNetwork>,
): ParsedAddress | null {
  let decoded: Bech32Decoded;
  try {
    decoded = decodeBech32(address, bech32mEncoding);
  } catch {
    return null;
  }

  const network = networkFromHrp(decoded.hrp, table);
  if (network === null) return null;

  const bytes = decoded.bytes;
  if (kind === 'sapling' && bytes.length !== 43) {
    throw new InvalidAddressError('Sapling address payload has the wrong length', 'malformed');
  }
  if (kind === 'unified' && bytes.length < 16) {
    throw new InvalidAddressError('Unified Address payload is too short', 'malformed');
  }

  return { address, kind, network };
}

/* -------------------------------------------------------------------------- */
/* Bech32 / Bech32m                                                           */
/* -------------------------------------------------------------------------- */
/*
 * Zcash address strings exceed the 90-character limit that most Bech32
 * libraries impose (a limit inherited from BIP 173's SegWit use case). Zcash
 * itself permits longer strings, so we implement the checksum here rather than
 * relying on a library that would reject valid Zcash addresses.
 *
 * This is a checksum/encoding routine, not cryptography. It is verified against
 * the reference test vectors in `packages/zcash/src/index.test.ts` and against
 * the official Rust `zcash_address` crate.
 */

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < BECH32_CHARSET.length; i++) map[BECH32_CHARSET[i]!] = i;
  return map;
})();

const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= generators[i]!;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const ch of hrp) out.push(ch.charCodeAt(0) >> 5);
  out.push(0);
  for (const ch of hrp) out.push(ch.charCodeAt(0) & 31);
  return out;
}

interface Bech32Decoded {
  hrp: string;
  words: number[];
  bytes: Uint8Array;
}

function decodeBech32(input: string, bech32mEncoding: boolean): Bech32Decoded {
  if (input.length < 8) throw new InvalidAddressError('address is too short', 'malformed');
  if (input.length > 512) throw new InvalidAddressError('address is too long', 'malformed');

  const hasLower = /[a-z]/.test(input);
  const hasUpper = /[A-Z]/.test(input);
  if (hasLower && hasUpper) {
    throw new InvalidAddressError('address mixes upper and lower case', 'malformed');
  }
  const address = input.toLowerCase();
  const sep = address.lastIndexOf('1');
  if (sep < 1 || sep + 7 > address.length) {
    throw new InvalidAddressError('address has no valid separator', 'malformed');
  }

  const hrp = address.slice(0, sep);
  const dataPart = address.slice(sep + 1);
  const values: number[] = [];
  for (const ch of dataPart) {
    const v = BECH32_LOOKUP[ch];
    if (v === undefined) {
      throw new InvalidAddressError(`invalid bech32 character: ${ch}`, 'malformed');
    }
    values.push(v);
  }

  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...values]);
  const expected = bech32mEncoding ? BECH32M_CONST : BECH32_CONST;
  if (polymod !== expected) {
    throw new InvalidAddressError('address checksum is invalid', 'bad_checksum');
  }

  const words = values.slice(0, -6);
  const bytes = convertBits(words, 5, 8, false);
  return { hrp, words, bytes };
}

function convertBits(data: number[], from: number, to: number, pad: boolean): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) {
      throw new InvalidAddressError('invalid bech32 data', 'malformed');
    }
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new InvalidAddressError('invalid bech32 padding', 'malformed');
  }
  return Uint8Array.from(out);
}

/** Validate an address against an explicit expected network. */
export function validateAddressForNetwork(
  address: string,
  network: ZcashNetwork,
): ParsedAddress {
  const parsed = parseAddress(address);
  if (parsed.network !== network) {
    throw new InvalidAddressError(
      `address is for ${parsed.network} but ${network} was expected`,
      'network_mismatch',
    );
  }
  return parsed;
}

/** Returns true when the address is valid on the given network. */
export function isValidAddressForNetwork(address: string, network: ZcashNetwork): boolean {
  try {
    validateAddressForNetwork(address, network);
    return true;
  } catch {
    return false;
  }
}

/** Memos are only valid for shielded (Sapling / Unified) recipients. */
export function addressSupportsMemo(kind: AddressKind): boolean {
  return kind === 'sapling' || kind === 'unified';
}

/** A short, non-sensitive fingerprint of an address for display/logging. */
export function addressFingerprint(address: string): string {
  const digest = sha256(new TextEncoder().encode(address));
  return bytesToHex(digest.slice(0, 6));
}

export { BASE58_ALPHABET };
