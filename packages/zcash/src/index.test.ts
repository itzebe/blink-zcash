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
