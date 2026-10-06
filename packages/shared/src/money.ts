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

/* ------------------------------------------------------------------ */
/* USD amounts and USD -> ZEC conversion                              */
/* ------------------------------------------------------------------ */

/** Maximum decimal places we accept for a USD input (cents). */
export const MAX_USD_DECIMALS = 2;

/**
 * Parse a decimal USD string into integer cents.
 *
 * Mirrors {@link parseZecToZatoshis}: same grammar (no separators, no sign, no
 * scientific notation) and the same "never silently change the value" rule.
 * More than two decimal places is rejected rather than rounded, so a price or
 * amount the user did not type is never invented.
 */
export function parseUsdToCents(value: string): bigint {
  if (typeof value !== 'string') throw new InvalidAmountError('USD amount must be a string');
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidAmountError(`invalid USD amount: ${value}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > MAX_USD_DECIMALS) {
    throw new InvalidAmountError(`USD amounts support at most ${MAX_USD_DECIMALS} decimal places`);
  }
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(MAX_USD_DECIMALS, '0') || '0');
  if (cents <= 0n) throw new InvalidAmountError('USD amount must be greater than zero');
  return cents;
}

/** Render integer cents as a canonical decimal USD string (e.g. 2500n -> "25", 2550n -> "25.5"). */
export function formatCentsToUsd(cents: bigint): string {
  if (cents < 0n) throw new InvalidAmountError('USD amount must not be negative');
  const whole = cents / 100n;
  const fraction = cents % 100n;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(2, '0').replace(/0+$/, '')}`;
}

/** Canonicalise a user-supplied USD string, rejecting malformed input. */
export function normaliseUsdAmount(value: string): string {
  return formatCentsToUsd(parseUsdToCents(value));
}

export interface UsdToZecConversion {
  /** Canonical USD amount (input). */
  usd: string;
  /** The ZEC/USD price used, as a canonical positive decimal string. */
  price: string;
  /** Canonical ZEC amount produced by the conversion. */
  zec: string;
  /** Zatoshis produced by the conversion (floor of the exact quotient). */
  zatoshis: bigint;
  /**
   * True when the exact quotient was not a whole number of zatoshis and was
   * rounded down (see {@link convertUsdToZec}).
   */
  rounded: boolean;
}

/** Decimal places accepted for a ZEC/USD price (sub-microcent precision). */
export const PRICE_DECIMALS = 8;
const PRICE_SCALE = 100_000_000n; // 10^PRICE_DECIMALS

/**
 * The zatoshi amount BLINK asks a payer for when settling a USD request.
 *
 * USD almost never converts to an exact whole number of zatoshis, so the exact
 * quotient is rounded UP to the next zatoshi. This guarantees the request asks
 * for at least the USD-equivalent value; the over-ask is strictly less than one
 * zatoshi (1e-8 ZEC). Rounding down would under-ask the payer.
 */
export function settleUsdToZatoshis(conversion: UsdToZecConversion): bigint {
  return conversion.rounded ? conversion.zatoshis + 1n : conversion.zatoshis;
}

/** Canonical ZEC amount BLINK settles a USD request in (see {@link settleUsdToZatoshis}). */
export function settledZecAmount(conversion: UsdToZecConversion): string {
  return formatZatoshisToZec(settleUsdToZatoshis(conversion));
}

/**
 * Parse a positive decimal ZEC/USD price into an integer scaled by 1e8.
 *
 * Prices legitimately carry more than two decimals, so this is deliberately
 * separate from {@link parseUsdToCents}. Zero, negative, malformed and
 * over-precise prices are rejected rather than coerced.
 */
export function parseUsdPrice(value: string): bigint {
  if (typeof value !== 'string') throw new InvalidAmountError('price must be a string');
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidAmountError(`invalid ZEC/USD price: ${value}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > PRICE_DECIMALS) {
    throw new InvalidAmountError(`ZEC/USD price supports at most ${PRICE_DECIMALS} decimal places`);
  }
  const scaled = BigInt(whole!) * PRICE_SCALE + BigInt(fraction.padEnd(PRICE_DECIMALS, '0') || '0');
  if (scaled <= 0n) throw new InvalidAmountError('ZEC/USD price must be greater than zero');
  return scaled;
}

/** Render a 1e8-scaled ZEC/USD price as a canonical decimal string. */
export function formatUsdPrice(scaled: bigint): string {
  if (scaled < 0n) throw new InvalidAmountError('price must not be negative');
  const whole = scaled / PRICE_SCALE;
  const fraction = scaled % PRICE_SCALE;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(PRICE_DECIMALS, '0').replace(/0+$/, '')}`;
}

/**
 * Convert a USD amount into ZEC using a ZEC/USD price.
 *
 * Exact arithmetic, no floating point:
 *
 *     zatoshis = floor( usdCents * ZATOSHIS_PER_ZEC * 1e8 / (100 * priceScaled) )
 *
 * which is the same as `usdCents / (100 * price) * ZATOSHIS_PER_ZEC`, i.e.
 * `USD / (USD per ZEC) * 1e8`. Example: $25 at $40/ZEC ->
 * 2500 * 1e8 * 1e8 / (100 * 4e9) = 62,500,000 zatoshis = 0.625 ZEC.
 *
 * Rounding policy: the exact rational is reduced once. If it is a whole number
 * of zatoshis it is used as-is; otherwise it is rounded DOWN (floor) to the
 * nearest zatoshi and `rounded: true` is returned. Flooring never asks the payer
 * for more ZEC than the USD amount strictly buys, and it is deterministic. The
 * caller decides whether to reject a rounded amount.
 *
 * The result is a canonical ZEC string (the same form the ZIP 321 builder
 * emits), so `amount=<zec>` carries the real converted value.
 */
export function convertUsdToZec(usdAmount: string, zecUsdPrice: string): UsdToZecConversion {
  const usdCents = parseUsdToCents(usdAmount);
  const priceScaled = parseUsdPrice(zecUsdPrice); // rejects zero/negative/malformed prices

  const numerator = usdCents * ZATOSHIS_PER_ZEC * PRICE_SCALE;
  const denominator = 100n * priceScaled;
  const zatoshis = numerator / denominator;
  const rounded = numerator % denominator !== 0n;

  if (zatoshis <= 0n) {
    throw new InvalidAmountError(
      `USD amount converts to zero ZEC at the current price (1 ZEC = $${formatUsdPrice(priceScaled)})`,
    );
  }
  if (zatoshis > MAX_ZEC * ZATOSHIS_PER_ZEC) {
    throw new InvalidAmountError('converted amount exceeds maximum ZEC supply');
  }

  return {
    usd: formatCentsToUsd(usdCents),
    price: formatUsdPrice(priceScaled),
    zec: formatZatoshisToZec(zatoshis),
    zatoshis,
    rounded,
  };
}
