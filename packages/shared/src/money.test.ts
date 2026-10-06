import { describe, expect, it } from 'vitest';
import {
  formatZatoshisToZec,
  parseZecToZatoshis,
  normaliseZecAmount,
  InvalidAmountError,
  MAX_ZEC,
  parseUsdToCents,
  formatCentsToUsd,
  normaliseUsdAmount,
  parseUsdPrice,
  formatUsdPrice,
  convertUsdToZec,
  settleUsdToZatoshis,
  settledZecAmount,
} from './money.js';

describe('parseZecToZatoshis', () => {
  it('parses whole ZEC', () => {
    expect(parseZecToZatoshis('25')).toBe(2_500_000_000n);
    expect(parseZecToZatoshis('050')).toBe(5_000_000_000n);
  });

  it('parses fractional ZEC', () => {
    expect(parseZecToZatoshis('0.5')).toBe(50_000_000n);
    expect(parseZecToZatoshis('00.500')).toBe(50_000_000n);
    expect(parseZecToZatoshis('1.00000001')).toBe(100_000_001n);
  });

  it('rejects ZIP 321 invalid amounts', () => {
    for (const bad of ['50,000.00', '50,00', '50.', '.5', '0.123456789', '']) {
      expect(() => parseZecToZatoshis(bad), bad).toThrow(InvalidAmountError);
    }
  });

  it('rejects zero and negatives', () => {
    expect(() => parseZecToZatoshis('0')).toThrow();
    expect(() => parseZecToZatoshis('-1')).toThrow();
  });

  it('rejects amounts above the supply cap', () => {
    expect(() => parseZecToZatoshis((MAX_ZEC + 1n).toString())).toThrow();
  });
});

describe('formatZatoshisToZec', () => {
  it('round-trips', () => {
    expect(formatZatoshisToZec(2_500_000_000n)).toBe('25');
    expect(formatZatoshisToZec(50_000_000n)).toBe('0.5');
    expect(formatZatoshisToZec(1n)).toBe('0.00000001');
  });

  it('normalises without changing value', () => {
    expect(normaliseZecAmount('25.00')).toBe('25');
    expect(normaliseZecAmount('0.50000000')).toBe('0.5');
    expect(normaliseZecAmount('1.00000001')).toBe('1.00000001');
  });
});

describe('parseUsdToCents / formatCentsToUsd', () => {
  it('parses and canonicalises USD', () => {
    expect(parseUsdToCents('25')).toBe(2500n);
    expect(parseUsdToCents('25.00')).toBe(2500n);
    expect(parseUsdToCents('0.05')).toBe(5n);
    expect(formatCentsToUsd(2500n)).toBe('25');
    expect(formatCentsToUsd(2550n)).toBe('25.5');
    expect(formatCentsToUsd(2505n)).toBe('25.05');
  });

  it('rejects malformed, over-precise, zero and negative USD', () => {
    for (const bad of ['25.001', '1,000', '.5', '25.', '', '-1', '0']) {
      expect(() => parseUsdToCents(bad), bad).toThrow(InvalidAmountError);
    }
  });

  it('normaliseUsdAmount rejects rather than rounds', () => {
    expect(normaliseUsdAmount('25.00')).toBe('25');
    expect(() => normaliseUsdAmount('25.005')).toThrow();
  });
});

describe('parseUsdPrice / formatUsdPrice', () => {
  it('accepts sub-cent prices', () => {
    expect(formatUsdPrice(parseUsdPrice('40'))).toBe('40');
    expect(formatUsdPrice(parseUsdPrice('40.25'))).toBe('40.25');
    expect(formatUsdPrice(parseUsdPrice('0.0001'))).toBe('0.0001');
    expect(formatUsdPrice(parseUsdPrice('1586.77'))).toBe('1586.77');
  });

  it('rejects zero, negative and malformed prices', () => {
    for (const bad of ['0', '-1', 'abc', '', '1.123456789']) {
      expect(() => parseUsdPrice(bad), bad).toThrow(InvalidAmountError);
    }
  });
});

describe('convertUsdToZec', () => {
  it('$25 at $40/ZEC -> 0.625 ZEC (test 1)', () => {
    const c = convertUsdToZec('25', '40');
    expect(c.zec).toBe('0.625');
    expect(c.zatoshis).toBe(62_500_000n);
    expect(c.rounded).toBe(false);
    expect(c.usd).toBe('25');
    expect(c.price).toBe('40');
  });

  it('$1 at $40/ZEC -> 0.025 ZEC, never 1 ZEC (test 2)', () => {
    const c = convertUsdToZec('1', '40');
    expect(c.zec).toBe('0.025');
    expect(c.zec).not.toBe('1');
    expect(c.zatoshis).toBe(2_500_000n);
  });

  it('$100 at $50/ZEC -> 2 ZEC (test 3)', () => {
    const c = convertUsdToZec('100', '50');
    expect(c.zec).toBe('2');
    expect(c.zatoshis).toBe(200_000_000n);
  });

  it('is exact for a sub-cent price', () => {
    const c = convertUsdToZec('25', '40.25');
    // 2500 / 4025 * 1e8 = 62111801.242... -> floor
    expect(c.zatoshis).toBe(62_111_801n);
    expect(c.rounded).toBe(true);
  });

  it('rejects zero/negative/malformed prices', () => {
    expect(() => convertUsdToZec('25', '0')).toThrow(InvalidAmountError);
    expect(() => convertUsdToZec('25', '-40')).toThrow(InvalidAmountError);
    expect(() => convertUsdToZec('25', 'nope')).toThrow(InvalidAmountError);
  });

  it('rejects an amount that converts to zero ZEC', () => {
    expect(() => convertUsdToZec('0.01', '100000000')).toThrow(InvalidAmountError);
  });
});

describe('settledZecAmount / settleUsdToZatoshis', () => {
  it('leaves an exact conversion unchanged', () => {
    const c = convertUsdToZec('25', '40'); // 0.625 ZEC exactly
    expect(c.rounded).toBe(false);
    expect(settleUsdToZatoshis(c)).toBe(62_500_000n);
    expect(settledZecAmount(c)).toBe('0.625');
  });

  it('rounds UP to the next zatoshi when the quotient is not whole', () => {
    const c = convertUsdToZec('25', '40.25'); // floor 62_111_801, remainder != 0
    expect(c.rounded).toBe(true);
    expect(settleUsdToZatoshis(c)).toBe(62_111_802n);
    expect(settledZecAmount(c)).toBe('0.62111802');
  });

  it('never under-asks for a realistic high ZEC price', () => {
    const c = convertUsdToZec('1', '1367.43');
    expect(settledZecAmount(c)).toBe('0.0007313');
    // strictly at least the floored (USD-equivalent) value
    expect(settleUsdToZatoshis(c) >= c.zatoshis).toBe(true);
    expect(settleUsdToZatoshis(c) - c.zatoshis < 2n).toBe(true);
  });
});
