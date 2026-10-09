import { describe, expect, it } from 'vitest';
import {
  parseAddress,
  validateAddressForNetwork,
  isValidAddressForNetwork,
  addressSupportsMemo,
  InvalidAddressError,
} from './index.js';

const TEST_SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const TEST_TRANSPARENT = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';
const MAIN_TRANSPARENT = 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs';
const TEST_UA =
  'utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s';
const MAIN_UA =
  'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf';

// Unified Address receiver-composition fixtures, cross-checked against the Rust
// `zcash_address` crate. These prove the TypeScript decoder reports the *actual*
// receivers, not the `u…` prefix.
// R0 UA: Orchard receiver only.
const TEST_UA_ORCHARD_ONLY =
  'utest1hap277en6ayclu5027232d44kv0s6nd0tacmnj07v0avarpuv4vzyfjreu3qexw05v9jvpx8ce37lpt5j4qexyrwhrlrma9msypee8x4';
// R0 UA: transparent (P2PKH) + Sapling.
const TEST_UA_TRANSPARENT_SAPLING =
  'utest1umlnyxwzc6rgz900aax35m4e5f3p2lfexpmsrkdw9mr48mk9m4twgww9xcwmdzvhr7gsp9r8djhhg8q0dgt0rfa3s95az5vq4x983lu2q070avytpcgrs8a99muv7zk3v6nzw8ylk6a';
// R2 UA (tutest…): transparent + Orchard.
const TEST_UA_R2_TRANSPARENT_ORCHARD =
  'tutest1g8sgu2gqav6mcswxfnha3yg7ajeznk6ykj3as93tnh32yyq56t9d32dxzgw66r5s4dge2gpr4m54ac9djwr4lm550u8ctpw9h6fl9f632j2dvq7cwugf5pyu5eds7gm5rtuxgrez927';
// R2 UA (tutest…): transparent receiver only. 54-byte payload, above the ZIP 316
// F4Jumble floor of 48; the authoritative Rust `zcash_address` crate accepts it.
const TEST_UA_R2_TRANSPARENT_ONLY =
  'tutest124lwpdn50kcu0ygd9xes9uv77u3rx2arrhgvw0kl7ucfll9hktkrecmdh95d8efalwahtld87wu4phtv7vw8y9g4tx7jy';
// R0 UA: Sapling + Orchard receivers, no transparent receiver. Generated with and
// accepted by the authoritative Rust `zcash_address` crate. Both shielded pools
// are present, so this is the canonical "shielded-only, memo-capable" recipient.
const TEST_UA_SAPLING_ORCHARD =
  'utest1udj294cv9avaz0utlaypnn6cp576nnzm49jq80rutejsq3jqz9pafpy8280hkf73w98n59vr02y37x3x9pzlnmd0m9f0zm7fxjh9humnl4ah77fxjcptakzq29thqhw9gu4n332mlh6868u2g4tsr3pp9qx3nxmsu6ztsaat3u6jhy3k';
// R2 UA (tutest…): a 38-byte payload, below ZIP 316's 48-byte F4Jumble floor.
// Not a validly-encoded UA; the authoritative Rust crate rejects it, and so must
// this decoder.
const TEST_UA_TOO_SHORT =
  'tutest1cj7gr2vpn260gfgq5pusg3rh4ac4zaqwukzwwh5q0mjtudm4uq0lcq5fqpx4jafqche';

describe('parseAddress', () => {
  it('classifies a testnet Sapling address', () => {
    expect(parseAddress(TEST_SAPLING)).toMatchObject({
      kind: 'sapling',
      network: 'testnet',
    });
  });

  it('classifies a testnet transparent address', () => {
    expect(parseAddress(TEST_TRANSPARENT)).toMatchObject({
      kind: 'transparent',
      network: 'testnet',
    });
  });

  it('classifies a mainnet transparent address', () => {
    expect(parseAddress(MAIN_TRANSPARENT)).toMatchObject({
      kind: 'transparent',
      network: 'mainnet',
    });
  });

  it('classifies testnet and mainnet Unified Addresses', () => {
    expect(parseAddress(TEST_UA)).toMatchObject({ kind: 'unified', network: 'testnet' });
    expect(parseAddress(MAIN_UA)).toMatchObject({ kind: 'unified', network: 'mainnet' });
  });

  it('rejects a corrupt checksum', () => {
    const corrupt = TEST_TRANSPARENT.slice(0, -1) + (TEST_TRANSPARENT.endsWith('U') ? 'V' : 'U');
    expect(() => parseAddress(corrupt)).toThrow(InvalidAddressError);
  });

  it('rejects empty and whitespace-padded input', () => {
    expect(() => parseAddress('')).toThrow();
    expect(() => parseAddress(` ${TEST_TRANSPARENT}`)).toThrow();
  });

  it('rejects Sprout addresses explicitly', () => {
    try {
      parseAddress('zc8E5gYid86n4bo2Usdq1cpr7PpfoJGzttwBHEEgGhGkLUg7SPPVFNB2AkRFXZ7usfphup5426dt1buMmY3fkYeRrQGLa8y');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidAddressError);
      expect((e as InvalidAddressError).reason).toBe('unsupported_sprout');
    }
  });
});

describe('network separation', () => {
  it('never confuses mainnet and testnet', () => {
    expect(isValidAddressForNetwork(MAIN_TRANSPARENT, 'testnet')).toBe(false);
    expect(isValidAddressForNetwork(TEST_TRANSPARENT, 'mainnet')).toBe(false);
    expect(isValidAddressForNetwork(MAIN_UA, 'testnet')).toBe(false);
    expect(isValidAddressForNetwork(TEST_UA, 'mainnet')).toBe(false);
  });

  it('accepts matching networks', () => {
    expect(validateAddressForNetwork(TEST_TRANSPARENT, 'testnet').network).toBe('testnet');
    expect(validateAddressForNetwork(MAIN_UA, 'mainnet').network).toBe('mainnet');
  });
});

describe('addressSupportsMemo', () => {
  it('is false for transparent and true for shielded', () => {
    expect(addressSupportsMemo('transparent')).toBe(false);
    expect(addressSupportsMemo('sapling')).toBe(true);
    expect(addressSupportsMemo('unified')).toBe(true);
  });
});

describe('Unified Address receiver inspection', () => {
  it('reports a Sapling receiver for a Sapling-only UA', () => {
    expect(parseAddress(TEST_UA).receivers).toMatchObject({
      transparent: false,
      sapling: true,
      orchard: false,
      shielded: true,
      transparentOnly: false,
    });
  });

  it('reports a transparent receiver for a UA that also exposes Sapling (mainnet fixture)', () => {
    const r = parseAddress(MAIN_UA).receivers;
    expect(r.sapling).toBe(true);
    expect(r.transparent).toBe(true);
    expect(r.transparentOnly).toBe(false);
    expect(r.shielded).toBe(true);
  });

  it('reports an Orchard-only UA as shielded and not transparent', () => {
    expect(parseAddress(TEST_UA_ORCHARD_ONLY).receivers).toMatchObject({
      orchard: true,
      shielded: true,
      transparent: false,
      transparentOnly: false,
    });
  });

  it('flags a UA that exposes transparent + Sapling as not transparent-only', () => {
    const r = parseAddress(TEST_UA_TRANSPARENT_SAPLING).receivers;
    expect(r.transparent).toBe(true);
    expect(r.sapling).toBe(true);
    expect(r.transparentOnly).toBe(false);
  });

  it('flags an R2 (tutest) UA that exposes a shielded receiver', () => {
    const r = parseAddress(TEST_UA_R2_TRANSPARENT_ORCHARD).receivers;
    expect(r.transparent).toBe(true);
    expect(r.orchard).toBe(true);
    expect(r.shielded).toBe(true);
    expect(r.transparentOnly).toBe(false);
  });

  it('marks a transparent-only UA as transparent-only', () => {
    const r = parseAddress(TEST_UA_R2_TRANSPARENT_ONLY).receivers;
    expect(r.transparent).toBe(true);
    expect(r.shielded).toBe(false);
    expect(r.transparentOnly).toBe(true);
  });

  it('reports both shielded receivers for a Sapling+Orchard UA', () => {
    const r = parseAddress(TEST_UA_SAPLING_ORCHARD).receivers;
    expect(r).toMatchObject({
      transparent: false,
      sapling: true,
      orchard: true,
      shielded: true,
      transparentOnly: false,
      unknown: false,
    });
  });

  it('rejects a UA below the ZIP 316 F4Jumble floor instead of decoding it', () => {
    // 38 bytes post-Bech32m: below ZIP 316's 48-byte minimum, so it cannot be a
    // validly-encoded UA. The Rust `zcash_address` crate rejects it as
    // InvalidEncoding; the decoder must agree rather than accept it.
    expect(() => parseAddress(TEST_UA_TOO_SHORT)).toThrow(InvalidAddressError);
  });

  it('reports the receiver pools for Sapling and transparent addresses', () => {
    expect(parseAddress(TEST_SAPLING).receivers).toMatchObject({
      sapling: true,
      shielded: true,
      transparentOnly: false,
    });
    expect(parseAddress(TEST_TRANSPARENT).receivers).toMatchObject({
      transparent: true,
      shielded: false,
      transparentOnly: true,
    });
  });
});
