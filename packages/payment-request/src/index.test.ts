import { describe, expect, it } from 'vitest';
import {
  buildZip321Uri,
  parseZip321Uri,
  parseSinglePayment,
  base64urlEncode,
  base64urlDecode,
  Zip321Error,
} from './index.js';

// Test vectors taken directly from ZIP 321 (https://zips.z.cash/zip-0321).
const TEST_SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const TEST_TRANSPARENT = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';
const MAIN_TRANSPARENT = 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs';
const TEST_UA =
  'utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s';
const MAIN_UA =
  'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf';

describe('base64url', () => {
  it('encodes without padding and uses the url-safe alphabet', () => {
    expect(base64urlEncode(new TextEncoder().encode('This is a simple memo.'))).toBe(
      'VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg',
    );
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
  });

  it('rejects standard base64 characters', () => {
    expect(() => base64urlDecode('a+b/=')).toThrow(Zip321Error);
  });
});

describe('parseZip321Uri — ZIP 321 valid examples', () => {
  it('parses a single Sapling payment with memo and message', () => {
    const uri = `${'zcash:'}${TEST_SAPLING}?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase`;
    const [payment] = parseZip321Uri(uri);
    expect(payment.address).toBe(TEST_SAPLING);
    expect(payment.amount).toBe('1');
    expect(payment.memo).toBe('This is a simple memo.');
    expect(payment.message).toBe('Thank you for your purchase');
  });

  it('parses multiple recipients with indexed parameters', () => {
    const uri = `zcash:?address=${TEST_TRANSPARENT}&amount=123.456&address.1=${TEST_SAPLING}&amount.1=0.789&memo.1=VGhpcyBpcyBhIHVuaWNvZGUgbWVtbyDinKjwn6aE8J-PhvCfjok`;
    const payments = parseZip321Uri(uri);
    expect(payments).toHaveLength(2);
    expect(payments[0]!.address).toBe(TEST_TRANSPARENT);
    expect(payments[0]!.amount).toBe('123.456');
    expect(payments[1]!.address).toBe(TEST_SAPLING);
    expect(payments[1]!.memo).toBe('This is a unicode memo ✨🦄🏆🎉');
  });

  it('parses a testnet Unified Address', () => {
    const payments = parseZip321Uri(`zcash:${TEST_UA}?amount=1`, { network: 'testnet' });
    expect(payments[0]!.address).toBe(TEST_UA);
  });
});

describe('parseZip321Uri — ZIP 321 invalid examples', () => {
  it('rejects a missing empty-index address', () => {
    const uri = `zcash:?amount=3491405.05201255&address.1=${TEST_SAPLING}&amount.1=5740296.87793245`;
    expect(() => parseZip321Uri(uri)).toThrow(Zip321Error);
  });

  it('rejects leading zeros in paramindex', () => {
    expect(() => parseZip321Uri(`zcash:?address.0=${TEST_SAPLING}&amount.0=2`)).toThrow(
      Zip321Error,
    );
  });

  it('rejects duplicate parameters', () => {
    expect(() =>
      parseZip321Uri(`zcash:?amount=1.234&amount=2.345&address=${TEST_TRANSPARENT}`),
    ).toThrow(Zip321Error);
  });

  it('rejects percent-encoding in parameter names and addresses', () => {
    expect(() => parseZip321Uri(`zcash:${TEST_TRANSPARENT}?amount=1%30`)).toThrow(Zip321Error);
    expect(() => parseZip321Uri(`zcash:${TEST_TRANSPARENT}?%61mount=1`)).toThrow(Zip321Error);
  });

  it('rejects an authority component', () => {
    expect(() => parseZip321Uri(`zcash://${TEST_TRANSPARENT}?amount=1`)).toThrow(Zip321Error);
  });

  it('rejects a memo on a transparent recipient', () => {
    expect(() =>
      parseZip321Uri(`zcash:${TEST_TRANSPARENT}?amount=1&memo=VGhpcyBpcyBhIG1lbW8`),
    ).toThrow(Zip321Error);
  });

  it('rejects amount + req-asset at the same index', () => {
    expect(() => parseZip321Uri(`zcash:${TEST_UA}?amount=1&req-asset=AAAA`)).toThrow(Zip321Error);
  });

  it('rejects an unknown required parameter', () => {
    expect(() => parseZip321Uri(`zcash:${TEST_SAPLING}?amount=1&req-foo=bar`)).toThrow(Zip321Error);
  });

  it('ignores unknown non-required parameters', () => {
    const [p] = parseZip321Uri(`zcash:${TEST_SAPLING}?amount=1&custom=anything`);
    expect(p!.amount).toBe('1');
  });

  it('rejects a non-zcash scheme', () => {
    expect(() => parseZip321Uri('bitcoin:abc?amount=1')).toThrow(Zip321Error);
  });

  it('rejects malformed amounts', () => {
    expect(() => parseZip321Uri(`zcash:${TEST_SAPLING}?amount=50,00`)).toThrow(Zip321Error);
    expect(() => parseZip321Uri(`zcash:${TEST_SAPLING}?amount=.5`)).toThrow(Zip321Error);
    expect(() => parseZip321Uri(`zcash:${TEST_SAPLING}?amount=0.123456789`)).toThrow(Zip321Error);
  });
});

describe('network separation', () => {
  it('rejects a mainnet transparent address parsed as testnet', () => {
    expect(() =>
      parseZip321Uri(`zcash:${MAIN_TRANSPARENT}?amount=1`, { network: 'testnet' }),
    ).toThrow(Zip321Error);
  });

  it('rejects a mainnet Unified Address parsed as testnet', () => {
    expect(() => parseZip321Uri(`zcash:${MAIN_UA}?amount=1`, { network: 'testnet' })).toThrow(
      Zip321Error,
    );
  });

  it('accepts the correct network', () => {
    expect(() =>
      parseZip321Uri(`zcash:${TEST_SAPLING}?amount=1`, { network: 'testnet' }),
    ).not.toThrow();
    expect(() => parseZip321Uri(`zcash:${MAIN_UA}?amount=1`, { network: 'mainnet' })).not.toThrow();
  });
});

describe('buildZip321Uri', () => {
  it('builds a canonical single-payment URI', () => {
    const uri = buildZip321Uri(
      [{ address: TEST_SAPLING, amount: '1', memo: 'This is a simple memo.' }],
      { network: 'testnet' },
    );
    expect(uri).toBe(`zcash:${TEST_SAPLING}?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg`);
  });

  it('normalises amounts without changing value', () => {
    const uri = buildZip321Uri([{ address: TEST_SAPLING, amount: '25.00' }], {
      network: 'testnet',
    });
    expect(uri).toContain('amount=25');
  });

  it('round-trips through the parser', () => {
    const uri = buildZip321Uri(
      [
        {
          address: TEST_SAPLING,
          amount: '2.5',
          memo: 'Dinner',
          label: 'Joseph',
          message: 'Thanks!',
        },
      ],
      { network: 'testnet' },
    );
    const [p] = parseZip321Uri(uri, { network: 'testnet' });
    expect(p!.amount).toBe('2.5');
    expect(p!.memo).toBe('Dinner');
    expect(p!.label).toBe('Joseph');
    expect(p!.message).toBe('Thanks!');
  });

  it('refuses to build for the wrong network', () => {
    expect(() =>
      buildZip321Uri([{ address: TEST_SAPLING, amount: '1' }], { network: 'mainnet' }),
    ).toThrow(Zip321Error);
  });

  it('refuses a memo on a transparent recipient', () => {
    expect(() =>
      buildZip321Uri([{ address: TEST_TRANSPARENT, amount: '1', memo: 'nope' }], {
        network: 'testnet',
      }),
    ).toThrow(Zip321Error);
  });

  it('refuses an over-long memo', () => {
    expect(() =>
      buildZip321Uri([{ address: TEST_SAPLING, amount: '1', memo: 'x'.repeat(513) }], {
        network: 'testnet',
      }),
    ).toThrow(/memo exceeds/i);
  });
});

describe('parseSinglePayment', () => {
  it('returns the single payment', () => {
    const p = parseSinglePayment(`zcash:${TEST_SAPLING}?amount=3`, { network: 'testnet' });
    expect(p.amount).toBe('3');
  });

  it('rejects multiple payments', () => {
    expect(() =>
      parseSinglePayment(
        `zcash:?address=${TEST_TRANSPARENT}&amount=1&address.1=${TEST_SAPLING}&amount.1=2`,
      ),
    ).toThrow(Zip321Error);
  });
});
