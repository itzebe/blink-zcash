/**
 * Zcash engine client.
 *
 * BLINK validates addresses and ZIP 321 URIs in two layers:
 *
 *  1. Locally, using the `@blink/payment-request` and `@blink/zcash` packages.
 *  2. Authoritatively, using the `blink-zcash` Rust service which wraps the
 *     official Zcash crates.
 *
 * When `BLINK_ZCASH_SERVICE_URL` is configured, layer 2 must agree before a
 * request is accepted. When it is not configured, BLINK says so honestly rather
 * than pretending the check happened.
 */
import type { AddressKind, ZcashNetwork } from '@blink/shared';

export interface InspectResult {
  address: string;
  kind: AddressKind;
  network: ZcashNetwork;
  canReceiveMemo: boolean;
  /**
   * The receiver pools actually present in the address. For a Unified Address
   * this is the real ZIP 316 receiver composition, so the caller can tell a
   * shielded-only UA from one that also (or only) exposes a transparent receiver.
   */
  receivers: AddressReceivers;
}

/** Receiver pools of an address, as reported by the authoritative engine. */
export interface AddressReceivers {
  transparent: boolean;
  sapling: boolean;
  orchard: boolean;
  /** Whether a shielded (Sapling or Orchard) receiver is present. */
  shielded: boolean;
  /** Whether the only recognized receivers are transparent ones. */
  transparentOnly: boolean;
  /** A receiver of an unrecognised typecode is present. */
  unknown: boolean;
}

export interface EngineResult<T> {
  value: T;
  /** Whether the authoritative engine confirmed this result. */
  authoritative: boolean;
}

export interface TransactionInfo {
  txid: string;
  size: number;
}

/** The pools a transaction touches, from its bundles. */
export interface TxPools {
  transparent: boolean;
  sapling: boolean;
  orchard: boolean;
  shielded: boolean;
}

/**
 * The public facts a transaction exposes, as decoded by the authoritative
 * engine. A transparent recipient and amount can be matched; a shielded one
 * cannot. `transparentRecipientZatoshis` is set only when the expected
 * recipient's transparent receiver was actually paid.
 */
export interface TransactionEvidence {
  txid: string;
  size: number;
  pools: TxPools;
  recipientHasTransparent: boolean;
  /** Whether the requested recipient exposes a shielded (Sapling/Orchard) receiver. */
  recipientHasShielded: boolean;
  transparentRecipientZatoshis: number | null;
}

export interface InspectTransactionOptions {
  network: ZcashNetwork;
  /** The requested recipient address. Lets the engine match a transparent output. */
  expectedAddress?: string;
  branch?: string;
}

export interface ZcashEngine {
  readonly configured: boolean;
  /**
   * Cheap liveness probe against the engine's `/health`. Resolves `true` when the
   * engine answers, `false` otherwise. Used by the API readiness probe to report
   * whether the authoritative engine is actually reachable, without performing
   * any validation work. An optional timeout lets the readiness probe answer
   * quickly while the engine is still cold-starting.
   */
  ping(timeoutMs?: number): Promise<boolean>;
  inspectAddress(address: string, network: ZcashNetwork): Promise<EngineResult<InspectResult>>;
  buildUri(
    payments: Array<{
      address: string;
      amount: string;
      memo?: string;
      label?: string;
      message?: string;
    }>,
    network: ZcashNetwork,
  ): Promise<EngineResult<string>>;
  /**
   * Decode raw transaction bytes and return the authoritative txid computed by
   * the official Zcash crates. Never fabricates a result: malformed bytes throw.
   */
  decodeTransaction(dataHex: string, branch?: string): Promise<EngineResult<TransactionInfo>>;
  /**
   * Decode raw transaction bytes and report the public verification facts: the
   * pools the transaction touches and, when an expected recipient is given, how
   * much it pays that recipient's transparent receiver. Never fabricates a
   * result: malformed bytes throw.
   */
  inspectTransaction(
    dataHex: string,
    options: InspectTransactionOptions,
  ): Promise<EngineResult<TransactionEvidence>>;
}

/**
 * The engine could not be used for this request.
 *
 * `reason` distinguishes a **definitive rejection** (`rejected`: the engine
 * answered and said the input is invalid, e.g. a wrong-network address) from a
 * **transient unavailability** (`unreachable`: timeout, connection refused, a
 * non-JSON host page, or a 5xx). The distinction is load-bearing: a rejection is
 * a real validation failure, while an unreachable engine must never be reported
 * as an invalid address — a cold-started engine would otherwise make a valid
 * address look invalid.
 */
export class EngineUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: 'unreachable' | 'rejected' = 'unreachable',
  ) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

/**
 * Map the engine's snake_case receiver pools onto the client shape, falling back
 * to a conservative derivation from the address kind when an older engine build
 * omits the field. A Unified Address with no receiver data is reported as
 * `unknown` — never defaulted to shielded — so a missing field can never make an
 * unconfirmed route look private.
 */
function normalizeReceivers(
  kind: AddressKind,
  raw?: {
    transparent: boolean;
    sapling: boolean;
    orchard: boolean;
    shielded: boolean;
    transparent_only: boolean;
    unknown: boolean;
  },
): AddressReceivers {
  if (raw) {
    return {
      transparent: raw.transparent,
      sapling: raw.sapling,
      orchard: raw.orchard,
      shielded: raw.shielded,
      transparentOnly: raw.transparent_only,
      unknown: raw.unknown,
    };
  }
  if (kind === 'sapling') {
    return {
      transparent: false,
      sapling: true,
      orchard: false,
      shielded: true,
      transparentOnly: false,
      unknown: false,
    };
  }
  if (kind === 'transparent') {
    return {
      transparent: true,
      sapling: false,
      orchard: false,
      shielded: false,
      transparentOnly: true,
      unknown: false,
    };
  }
  return {
    transparent: false,
    sapling: false,
    orchard: false,
    shielded: false,
    transparentOnly: false,
    unknown: true,
  };
}

export function createZcashEngine(serviceUrl: string, defaultTimeoutMs = 10_000): ZcashEngine {
  const configured = serviceUrl.length > 0;

  async function call<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), defaultTimeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(new URL(path, serviceUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        // Network-level failure (timeout, DNS, connection refused): transient.
        throw new EngineUnavailableError(
          `blink-zcash service unreachable: ${err instanceof Error ? err.message : String(err)}`,
          'unreachable',
        );
      }

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        // A non-JSON body means the URL did not reach the engine (a frontend, a
        // proxy, or a host's HTML 404 page). Report that plainly instead of
        // surfacing a raw `Unexpected token '<'` parse error. Transient: the
        // engine may simply be cold-starting behind a proxy.
        throw new EngineUnavailableError(
          `blink-zcash service returned a non-JSON response (HTTP ${res.status}) from ${path}; ` +
            'the configured BLINK_ZCASH_SERVICE_URL does not point at the blink-zcash engine',
          'unreachable',
        );
      }
      if (!res.ok) {
        const message = typeof json.error === 'string' ? json.error : 'engine rejected request';
        // A 5xx is the engine (or its proxy) failing, not a verdict on the
        // input. Only 4xx responses are definitive rejections.
        const reason = res.status >= 500 ? 'unreachable' : 'rejected';
        throw new EngineUnavailableError(message, reason);
      }
      return json as T;
    } catch (err) {
      // Any error that is not already classified (e.g. reading the body failed)
      // is a transport problem, never a verdict on the input.
      if (err instanceof EngineUnavailableError) throw err;
      throw new EngineUnavailableError(
        `blink-zcash service unreachable: ${err instanceof Error ? err.message : String(err)}`,
        'unreachable',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    configured,

    async ping(timeoutMs) {
      if (!configured) return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeoutMs);
      try {
        const res = await fetch(new URL('/health', serviceUrl), {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },

    async inspectAddress(address, network) {
      if (!configured) {
        throw new EngineUnavailableError('BLINK_ZCASH_SERVICE_URL is not configured');
      }
      const json = await call<{
        address: string;
        kind: string;
        network: string;
        can_receive_memo: boolean;
        receivers?: {
          transparent: boolean;
          sapling: boolean;
          orchard: boolean;
          shielded: boolean;
          transparent_only: boolean;
          unknown: boolean;
        };
      }>('/v1/address/inspect', { address, network });
      return {
        value: {
          address: json.address,
          kind: json.kind as AddressKind,
          network: json.network as ZcashNetwork,
          canReceiveMemo: json.can_receive_memo,
          receivers: normalizeReceivers(json.kind as AddressKind, json.receivers),
        },
        authoritative: true,
      };
    },

    async buildUri(payments, network) {
      if (!configured) {
        throw new EngineUnavailableError('BLINK_ZCASH_SERVICE_URL is not configured');
      }
      const json = await call<{ uri: string }>('/v1/zip321/build', { payments, network });
      return { value: json.uri, authoritative: true };
    },

    async decodeTransaction(dataHex, branch) {
      if (!configured) {
        throw new EngineUnavailableError('BLINK_ZCASH_SERVICE_URL is not configured');
      }
      const json = await call<{ txid: string; size: number }>('/v1/transaction/inspect', {
        data: dataHex,
        ...(branch ? { branch } : {}),
      });
      return {
        value: { txid: json.txid, size: json.size },
        authoritative: true,
      };
    },

    async inspectTransaction(dataHex, options) {
      if (!configured) {
        throw new EngineUnavailableError('BLINK_ZCASH_SERVICE_URL is not configured');
      }
      const json = await call<{
        txid: string;
        size: number;
        pools: TxPools;
        recipient_has_transparent: boolean;
        recipient_has_shielded: boolean;
        transparent_recipient_zatoshis: number | null;
      }>('/v1/transaction/inspect', {
        data: dataHex,
        network: options.network,
        ...(options.expectedAddress ? { expected_address: options.expectedAddress } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
      });
      return {
        value: {
          txid: json.txid,
          size: json.size,
          pools: json.pools,
          recipientHasTransparent: json.recipient_has_transparent,
          recipientHasShielded: json.recipient_has_shielded,
          transparentRecipientZatoshis: json.transparent_recipient_zatoshis,
        },
        authoritative: true,
      };
    },
  };
}
