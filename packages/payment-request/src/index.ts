/**
 * ZIP 321 — Payment Request URIs.
 *
 * This module is a from-scratch, standards-faithful implementation of
 * https://zips.z.cash/zip-0321. It generates and parses `zcash:` payment
 * request URIs. It is deliberately strict: any URI that does not conform to the
 * ABNF grammar in the ZIP is rejected rather than coerced.
 *
 * The parser does not perform any cryptography. It decodes public address
 * encodings (via `@blink/zcash`) and validates the URI structure.
 *
 * References:
 *  - ZIP 321: Payment Request URIs            https://zips.z.cash/zip-0321
 *  - RFC 3986: URI Generic Syntax             https://www.rfc-editor.org/rfc/rfc3986
 *  - RFC 4648 §5: base64url                   https://www.rfc-editor.org/rfc/rfc4648#section-5
 */

import {
  formatZatoshisToZec,
  parseZecToZatoshis,
  MAX_MEMO_BYTES,
  type ZcashNetwork,
} from '@blink/shared';
import {
  InvalidAddressError,
  addressSupportsMemo,
  parseAddress,
  validateAddressForNetwork,
} from '@blink/zcash';

export const ZCASH_URI_SCHEME = 'zcash:';

export type Zip321ErrorReason =
  | 'not_a_uri'
  | 'bad_grammar'
  | 'duplicate_param'
  | 'missing_address'
  | 'invalid_address'
  | 'invalid_amount'
  | 'invalid_memo'
  | 'memo_not_supported'
  | 'invalid_network'
  | 'unknown_required_param'
  | 'amount_and_asset'
  | 'invalid_encoding';

export class Zip321Error extends Error {
  constructor(
    message: string,
    public readonly reason: Zip321ErrorReason,
  ) {
    super(message);
    this.name = 'Zip321Error';
  }
}

export interface Zip321Payment {
  address: string;
  /** Canonical decimal ZEC string, e.g. "25" or "0.5". */
  amount: string;
  /** Plaintext memo (already decoded from base64url). */
  memo?: string;
  label?: string;
  message?: string;
}

export interface BuildZip321Options {
  /**
   * When true (default) each address is validated before it is written into a
   * URI. Set to false only in tests that intentionally exercise malformed data.
   */
  validate?: boolean;
  /** Expected network; when provided, addresses are checked against it. */
  network?: ZcashNetwork;
}

export interface ParseZip321Options {
  /**
   * When provided, every address is required to belong to this network.
   */
  network?: ZcashNetwork;
}

/* -------------------------------------------------------------------------- */
/* Encoding helpers                                                           */
/* -------------------------------------------------------------------------- */

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encode bytes as unpadded base64url (RFC 4648 §5). */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2]!;
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

const BASE64URL_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) map[BASE64URL_ALPHABET[i]!] = i;
  return map;
})();

/**
 * Decode unpadded base64url. Rejects the standard base64 characters `+`, `/`
 * and `=` which ZIP 321 explicitly forbids.
 */
export function base64urlDecode(input: string): Uint8Array {
  if (/[+/=]/.test(input)) {
    throw new Zip321Error('base64url must not contain +, / or =', 'invalid_encoding');
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    const value = BASE64URL_LOOKUP[ch];
    if (value === undefined) {
      throw new Zip321Error(`invalid base64url character: ${ch}`, 'invalid_encoding');
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Percent-encode a string so that only ZIP 321 `qchar` productions remain
 * percent-encoded; all characters that `qchar` permits literally are left
 * literal.
 */
export function encodeQchar(value: string): string {
  return encodeURIComponent(value)
    .replace(/%24/g, '$')
    .replace(/%2C/g, ',')
    .replace(/%3B/g, ';')
    .replace(/%2B/g, '+')
    .replace(/%3A/g, ':')
    .replace(/%40/g, '@');
}

/** Decode a `qchar` value, rejecting malformed percent-encoding. */
export function decodeQchar(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Zip321Error('invalid percent-encoding in URI parameter', 'invalid_encoding');
  }
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a valid ZIP 321 URI from one or more payments.
 *
 * The first payment's address is placed in the `hier-part` of the URI, matching
 * the ZIP's single-payment recommendation. Additional payments use indexed
 * `address.N` parameters.
 */
export function buildZip321Uri(
  payments: Zip321Payment[],
  options: BuildZip321Options = {},
): string {
  const { validate = true, network } = options;
  if (!Array.isArray(payments) || payments.length === 0) {
    throw new Zip321Error('at least one payment is required', 'bad_grammar');
  }

  const prepared = payments.map((payment, i) => {
    if (typeof payment.address !== 'string' || payment.address.length === 0) {
      throw new Zip321Error(`payment ${i} has no address`, 'invalid_address');
    }
    // Canonicalise the amount; this throws on malformed input and never
    // silently changes the value.
    const canonicalAmount = formatZatoshisToZec(parseZecToZatoshis(payment.amount));

    let kind: ReturnType<typeof parseAddress>['kind'] | undefined;
    if (validate) {
      try {
        const parsed = network
          ? validateAddressForNetwork(payment.address, network)
          : parseAddress(payment.address);
        kind = parsed.kind;
      } catch (err) {
        if (err instanceof InvalidAddressError) {
          const reason: Zip321ErrorReason =
            err.reason === 'network_mismatch' ? 'invalid_network' : 'invalid_address';
          throw new Zip321Error(`invalid recipient address: ${err.message}`, reason);
        }
        throw err;
      }
    }

    if (payment.memo !== undefined && payment.memo !== null) {
      if (validate && kind !== undefined && !addressSupportsMemo(kind)) {
        throw new Zip321Error(`memo is not supported for ${kind} recipients`, 'memo_not_supported');
      }
      const memoBytes = new TextEncoder().encode(payment.memo);
      if (memoBytes.length > MAX_MEMO_BYTES) {
        throw new Zip321Error(
          `memo exceeds ${MAX_MEMO_BYTES} bytes when UTF-8 encoded`,
          'invalid_memo',
        );
      }
    }

    return { ...payment, amount: canonicalAmount };
  });

  const params: string[] = [];
  const [first, ...rest] = prepared;
  const hierPart = first!.address;

  const append = (index: number, payment: Zip321Payment): void => {
    const suffix = index === 0 ? '' : `.${index}`;
    if (index > 0) params.push(`address${suffix}=${payment.address}`);
    params.push(`amount${suffix}=${payment.amount}`);
    if (payment.memo)
      params.push(`memo${suffix}=${base64urlEncode(new TextEncoder().encode(payment.memo))}`);
    if (payment.label) params.push(`label${suffix}=${encodeQchar(payment.label)}`);
    if (payment.message) params.push(`message${suffix}=${encodeQchar(payment.message)}`);
  };

  append(0, first!);
  rest.forEach((payment, i) => append(i + 1, payment));

  return `${ZCASH_URI_SCHEME}${hierPart}?${params.join('&')}`;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9+-]*$/;
const PARAM_INDEX_RE = /^\.[1-9]\d{0,3}$/;
const ZCASH_ADDRESS_RE = /^[A-Za-z0-9]+$/;

const KNOWN_PARAMS = new Set(['address', 'amount', 'req-asset', 'label', 'memo', 'message']);

interface RawParam {
  base: string;
  /** Empty string for the empty paramindex; otherwise ".N". */
  index: string;
}

/**
 * Parse a ZIP 321 URI. Throws {@link Zip321Error} when the URI does not conform
 * to the grammar or contains an invalid required parameter.
 */
export function parseZip321Uri(uri: string, options: ParseZip321Options = {}): Zip321Payment[] {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Zip321Error('payment request must be a non-empty string', 'not_a_uri');
  }
  if (!uri.startsWith(ZCASH_URI_SCHEME)) {
    throw new Zip321Error('payment request must start with "zcash:"', 'not_a_uri');
  }
  if (uri.startsWith(`${ZCASH_URI_SCHEME}//`)) {
    throw new Zip321Error('ZIP 321 URIs must not contain an authority component', 'bad_grammar');
  }

  const body = uri.slice(ZCASH_URI_SCHEME.length);
  const questionMark = body.indexOf('?');
  const hierPart = questionMark === -1 ? body : body.slice(0, questionMark);
  const query = questionMark === -1 ? '' : body.slice(questionMark + 1);

  if (hierPart !== '' && !ZCASH_ADDRESS_RE.test(hierPart)) {
    throw new Zip321Error('address component contains invalid characters', 'bad_grammar');
  }

  // index -> collected parameters
  const groups = new Map<string, Map<string, string>>();
  const seen = new Set<string>();

  const ensureGroup = (index: string): Map<string, string> => {
    let group = groups.get(index);
    if (!group) {
      group = new Map();
      groups.set(index, group);
    }
    return group;
  };

  if (query.length > 0) {
    for (const pair of query.split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      const rawValue = eq === -1 ? undefined : pair.slice(eq + 1);

      if (rawName.includes('%')) {
        throw new Zip321Error('percent-encoding is not allowed in parameter names', 'bad_grammar');
      }

      const { base, index } = splitParamName(rawName);
      const dedupeKey = `${base}${index}`;
      if (seen.has(dedupeKey)) {
        throw new Zip321Error(`duplicate parameter ${dedupeKey}`, 'duplicate_param');
      }
      seen.add(dedupeKey);

      if (!KNOWN_PARAMS.has(base)) {
        if (base.startsWith('req-')) {
          throw new Zip321Error(
            `unsupported required parameter: ${base}`,
            'unknown_required_param',
          );
        }
        // Unknown, non-required parameters are ignored per ZIP 321.
        continue;
      }

      if (rawValue === undefined) {
        throw new Zip321Error(`parameter ${base} is missing a value`, 'bad_grammar');
      }

      ensureGroup(index).set(base, rawValue);
    }
  }

  // The hier-part address, when present, is the payment with the empty index.
  if (hierPart !== '') {
    const group = ensureGroup('');
    if (group.has('address')) {
      throw new Zip321Error(
        'address specified both in the URI path and as an address parameter',
        'duplicate_param',
      );
    }
    group.set('address', hierPart);
  }

  if (groups.size === 0) {
    throw new Zip321Error('payment request contains no payments', 'missing_address');
  }

  const payments: Zip321Payment[] = [];
  for (const [index, group] of groups) {
    const address = group.get('address');
    if (address === undefined) {
      throw new Zip321Error(`payment${index} has parameters but no address`, 'missing_address');
    }

    const hasAmount = group.has('amount');
    const hasAsset = group.has('req-asset');
    if (hasAmount && hasAsset) {
      throw new Zip321Error(
        'amount and req-asset are mutually exclusive for the same payment',
        'amount_and_asset',
      );
    }
    if (hasAsset) {
      throw new Zip321Error(
        'custom asset payments (req-asset) are not supported by BLINK',
        'unknown_required_param',
      );
    }

    let parsedAddress;
    try {
      parsedAddress = options.network
        ? validateAddressForNetwork(address, options.network)
        : parseAddress(address);
    } catch (err) {
      if (err instanceof InvalidAddressError) {
        const reason: Zip321ErrorReason =
          err.reason === 'network_mismatch' ? 'invalid_network' : 'invalid_address';
        throw new Zip321Error(`invalid recipient address: ${err.message}`, reason);
      }
      throw err;
    }

    let amount = '0';
    const rawAmount = group.get('amount');
    if (rawAmount !== undefined) {
      try {
        amount = formatZatoshisToZec(parseZecToZatoshis(rawAmount));
      } catch (err) {
        throw new Zip321Error(
          `invalid amount for payment${index}: ${(err as Error).message}`,
          'invalid_amount',
        );
      }
    }

    let memo: string | undefined;
    const rawMemo = group.get('memo');
    if (rawMemo !== undefined) {
      if (!addressSupportsMemo(parsedAddress.kind)) {
        throw new Zip321Error(
          `memo is not permitted for a ${parsedAddress.kind} address`,
          'memo_not_supported',
        );
      }
      let memoBytes: Uint8Array;
      try {
        memoBytes = base64urlDecode(rawMemo);
      } catch {
        throw new Zip321Error(`invalid memo encoding for payment${index}`, 'invalid_memo');
      }
      if (memoBytes.length > MAX_MEMO_BYTES) {
        throw new Zip321Error(
          `memo for payment${index} exceeds ${MAX_MEMO_BYTES} bytes`,
          'invalid_memo',
        );
      }
      memo = new TextDecoder().decode(memoBytes);
    }

    const label = group.has('label') ? decodeQchar(group.get('label')!) : undefined;
    const message = group.has('message') ? decodeQchar(group.get('message')!) : undefined;

    payments.push({
      address,
      amount,
      ...(memo !== undefined ? { memo } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  }

  return payments;
}

function splitParamName(name: string): RawParam {
  const dot = name.indexOf('.');
  if (dot === -1) {
    if (!PARAM_NAME_RE.test(name)) {
      throw new Zip321Error(`invalid parameter name: ${name}`, 'bad_grammar');
    }
    return { base: name, index: '' };
  }
  const base = name.slice(0, dot);
  const index = name.slice(dot);
  if (!PARAM_NAME_RE.test(base)) {
    throw new Zip321Error(`invalid parameter name: ${name}`, 'bad_grammar');
  }
  if (!PARAM_INDEX_RE.test(index)) {
    throw new Zip321Error(`invalid parameter index: ${index}`, 'bad_grammar');
  }
  return { base, index };
}

/**
 * Convenience wrapper that parses a URI and asserts it describes exactly one
 * payment for the expected network. Returns the single payment.
 */
export function parseSinglePayment(uri: string, options: ParseZip321Options = {}): Zip321Payment {
  const payments = parseZip321Uri(uri, options);
  if (payments.length !== 1) {
    throw new Zip321Error(`expected exactly one payment, found ${payments.length}`, 'bad_grammar');
  }
  return payments[0]!;
}

/** Build a ZIP 321 URI for a single payment. */
export function buildSinglePaymentUri(
  payment: Zip321Payment,
  options: BuildZip321Options = {},
): string {
  return buildZip321Uri([payment], options);
}
