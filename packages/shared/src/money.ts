/**
 * ZEC amount handling.
 *
 * Zcash has 8 decimal places of precision (1 ZEC = 100_000_000 zatoshis). All
 * arithmetic in BLINK is done on integer zatoshis so that amounts are never
 * silently rounded or changed by floating-point error.
 */

export const ZATOSHIS_PER_ZEC = 100_000_000n;

/** Maximum ZEC supply, as enforced by the protocol. */
export const MAX_ZEC = 21_000_000n;

export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

/**
 * Parse a decimal ZEC string into integer zatoshis.
 *
 * Follows the ZIP 321 amount grammar: a period separates whole and fractional
 * parts, both must be non-empty when a period is present, no thousands
 * separators, at most 8 decimal places.
 */
export function parseZecToZatoshis(value: string): bigint {
  if (typeof value !== 'string') throw new InvalidAmountError('amount must be a string');
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidAmountError(`invalid ZEC amount: ${value}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > 8) {
    throw new InvalidAmountError('ZEC amounts support at most 8 decimal places');
  }
  const wholeZat = BigInt(whole!) * ZATOSHIS_PER_ZEC;
  const fracZat = BigInt(fraction.padEnd(8, '0') || '0');
  const total = wholeZat + fracZat;
  if (total > MAX_ZEC * ZATOSHIS_PER_ZEC) {
    throw new InvalidAmountError('amount exceeds maximum ZEC supply');
  }
  if (total <= 0n) {
    throw new InvalidAmountError('amount must be greater than zero');
  }
  return total;
}

/** Render integer zatoshis as a canonical decimal ZEC string. */
export function formatZatoshisToZec(zatoshis: bigint): string {
  if (zatoshis < 0n) throw new InvalidAmountError('amount must not be negative');
  const whole = zatoshis / ZATOSHIS_PER_ZEC;
  const fraction = zatoshis % ZATOSHIS_PER_ZEC;
  if (fraction === 0n) return whole.toString();
  const frac = fraction.toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}.${frac}`;
}

/** Canonicalise a user-supplied ZEC string, rejecting malformed input. */
export function normaliseZecAmount(value: string): string {
  return formatZatoshisToZec(parseZecToZatoshis(value));
}

/** Convenience helper used by the UI for display. */
export function formatZecDisplay(value: string): string {
  const zat = parseZecToZatoshis(value);
  const zec = formatZatoshisToZec(zat);
  return `${zec} ZEC`;
}
