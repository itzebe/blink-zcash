import { describe, expect, it } from 'vitest';
import {
  formatZatoshisToZec,
  parseZecToZatoshis,
  normaliseZecAmount,
  InvalidAmountError,
  MAX_ZEC,
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
