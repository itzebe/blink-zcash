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

/**
 * The engine's honest, viewing-key-backed result of checking whether a
 * transaction actually paid the intended shielded recipient.
 *
 * Mirrors `blink_zcash::ShieldedPaymentVerification` exactly. A viewing key can
 * only *detect* incoming notes; it cannot spend. The engine sets
 * `recipientVerified` only when a recovered note's recipient equals the exact
 * requested address byte-for-byte, and only when the decoded bytes match the
 * expected transaction id — so an unrelated mined transaction can never satisfy
 * a claim.
 */
export interface ShieldedPaymentVerification {
  /** The txid computed from the bytes (never trusted from input). */
  txid: string;
  /**
   * Whether the computed txid equals the expected txid. `true` when none was
   * supplied. A `false` value means no recipient match may be credited.
   */
  txidMatches: boolean;
  /** Whether a recovered note's recipient equals the requested address. */
  recipientVerified: boolean;
  /** Total zatoshis recovered to the requested recipient, across all pools.
   * Reported as 0 unless `txidMatches` is true. */
  recipientZatoshis: number;
  /** Whether the recovered amount equals the requested amount. */
  amountVerified: boolean;
  /** The requested amount in zatoshis, when one was supplied. */
  expectedZatoshis: number | null;
  /** Whether the transaction carried Sapling activity. */
  sapling: boolean;
  /** Whether the transaction carried Orchard activity. */
  orchard: boolean;
  /** The pools in which a note to the requested recipient was recovered. */
  poolsWithRecipientNotes: string[];
  /** Whether the viewing key carried a Sapling component. */
  keyHasSapling: boolean;
  /** Whether the viewing key carried an Orchard component. */
  keyHasOrchard: boolean;
}

export interface InspectViewingKeyOptions {
  network: ZcashNetwork;
  /**
   * The recipient's Unified viewing key. Server-side only: never logged, never
   * returned to a client.
   */
  viewingKey: string;
  /**
   * The recipient address the key is to be associated with. When supplied, the
   * engine reports whether the key can derive one of that address's shielded
   * receivers.
   */
  expectedAddress?: string;
}

/**
 * A non-secret summary of a Unified viewing key, as reported by the engine. It
 * never contains key material.
 */
export interface ViewingKeyInspection {
  valid: boolean;
  network: ZcashNetwork;
  sapling: boolean;
  orchard: boolean;
  /**
   * Whether the key can derive a shielded receiver of the supplied address.
   * `null` when no address was supplied.
   */
  addressMatchesKey: boolean | null;
}

export interface VerifyShieldedOptions {
  network: ZcashNetwork;
  /**
   * The recipient's Unified viewing key (`uivk…`/`uview…`, or their `…test`
   * forms). A viewing key can only detect incoming notes; it cannot spend.
   * Server-side only: never logged and never returned to a client.
   */
  viewingKey: string;
  /** The expected recipient address. A note is attributed only on an exact match. */
  expectedAddress: string;
  /**
   * The requested amount in zatoshis. When supplied, the engine reports whether
   * the recovered amount matches exactly (a short payment is not a match).
   */
  expectedZatoshis?: number;
  /** The expected txid. Binds the decoded bytes to the request's claim. */
  expectedTxid?: string;
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
  /**
   * Establish, from the raw transaction bytes, whether the transaction actually
   * paid the intended shielded recipient — by trial-decrypting the transaction's
   * shielded outputs with the recipient's viewing key. This is the only path by
   * which BLINK can prove a *specific* shielded recipient received a *specific*
   * amount. It never fabricates a match: a wrong recipient, a wrong amount, a
   * mismatched txid, or a transaction with no note to the recipient all yield
   * `recipientVerified: false`.
   */
  verifyShielded(
    dataHex: string,
    options: VerifyShieldedOptions,
  ): Promise<EngineResult<ShieldedPaymentVerification>>;
  /**
   * Validate a Unified viewing key and, when a recipient address is supplied,
   * establish whether the key can derive one of that address's shielded
   * receivers. This is what binds a supplied key to the request it may verify,
   * so a requester cannot attach a key for a different account. It never
   * fabricates an association: a key that cannot derive the address reports
   * `addressMatchesKey: false`.
   */
  inspectViewingKey(
    options: InspectViewingKeyOptions,
  ): Promise<EngineResult<ViewingKeyInspection>>;
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

export function createZcashEngine(
  serviceUrl: string,
  defaultTimeoutMs = 10_000,
  wakeTimeoutMs = 120_000,
): ZcashEngine {
  const configured = serviceUrl.length > 0;

  /**
   * Bounded readiness wait. A cold Render Free engine takes ~80s to answer, far
   * longer than a single call's `defaultTimeoutMs`, so the first authoritative
   * call after an idle period would exhaust its retries and fail. This waits,
   * with backoff, until the engine's `/health` answers or the budget runs out.
   *
   * It is idempotent (a GET probe), shared between concurrent callers (one
   * in-flight wait is reused), and never invents a result: it returns as soon as
   * the engine answers, or `false` when it does not, and the caller then makes
   * its normal call and surfaces the honest `engine_unavailable` failure. It is
   * skipped entirely when the engine is not configured.
   */
  let wakeInFlight: Promise<boolean> | null = null;
  function ensureAwake(): Promise<boolean> {
    // A non-positive budget disables the wait (used by unit tests that drive the
    // call path directly). Production always passes a positive budget.
    if (!configured || wakeTimeoutMs <= 0) return Promise.resolve(false);
    if (wakeInFlight) return wakeInFlight;
    wakeInFlight = (async () => {
      const deadline = Date.now() + wakeTimeoutMs;
      let delay = 500;
      for (;;) {
        const probe = new AbortController();
        const timer = setTimeout(() => probe.abort(), 3_000);
        try {
          const res = await fetch(new URL('/health', serviceUrl), {
            headers: { accept: 'application/json' },
            signal: probe.signal,
          });
          if (res.ok) return true;
        } catch {
          // Unreachable (still cold-starting, or a transient network error).
        } finally {
          clearTimeout(timer);
        }
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 5_000);
      }
    })().finally(() => {
      wakeInFlight = null;
    });
    return wakeInFlight;
  }

  async function call<T>(path: string, body: unknown): Promise<T> {
    // Wake a cold engine before the first authoritative call, so the retries
    // below run against a warm engine instead of a booting one.
    await ensureAwake();
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

    async verifyShielded(dataHex, options) {
      if (!configured) {
        throw new EngineUnavailableError('BLINK_ZCASH_SERVICE_URL is not configured');
      }
      const json = await call<Record<string, unknown>>('/v1/transaction/verify-shielded', {
        data: dataHex,
        network: options.network,
        viewing_key: options.viewingKey,
        expected_address: options.expectedAddress,
        ...(options.expectedZatoshis !== undefined
          ? { expected_zatoshis: options.expectedZatoshis }
          : {}),
        ...(options.expectedTxid ? { expected_txid: options.expectedTxid } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
      });

      // Validate the engine's response before trusting it. A malformed or
      // truncated body must fail closed (unavailable), never be coerced into a
      // successful verification: `Boolean(undefined)` is `false`, but a wrong
      // shape could otherwise surface as a type-confused record.
      const txid = json.txid;
      if (
        typeof txid !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(txid) ||
        typeof json.txid_matches !== 'boolean' ||
        typeof json.recipient_verified !== 'boolean' ||
        typeof json.amount_verified !== 'boolean' ||
        typeof json.recipient_zatoshis !== 'number' ||
        !Number.isInteger(json.recipient_zatoshis) ||
        json.recipient_zatoshis < 0
      ) {
        throw new EngineUnavailableError(
          'blink-zcash service returned a malformed shielded verification response',
          'unreachable',
        );
      }

      return {
        value: {
          txid,
          txidMatches: json.txid_matches,
          recipientVerified: json.recipient_verified,
          recipientZatoshis: json.recipient_zatoshis,
          amountVerified: json.amount_verified,
          expectedZatoshis:
            typeof json.expected_zatoshis === 'number' ? json.expected_zatoshis : null,
          sapling: json.sapling === true,
          orchard: json.orchard === true,
          poolsWithRecipientNotes: Array.isArray(json.pools_with_recipient_notes)
            ? json.pools_with_recipient_notes.filter((p): p is string => typeof p === 'string')
            : [],
          keyHasSapling: json.key_has_sapling === true,
          keyHasOrchard: json.key_has_orchard === true,
        },
        authoritative: true,
      };
    },

    async inspectViewingKey(options) {
      if (!configured) {
        throw new EngineUnavailableError('BLINK_ZCASH_SERVICE_URL is not configured');
      }
      const json = await call<Record<string, unknown>>('/v1/viewing-key/inspect', {
        viewing_key: options.viewingKey,
        network: options.network,
        ...(options.expectedAddress ? { expected_address: options.expectedAddress } : {}),
      });

      // Fail closed on a malformed body: a missing field must never be coerced
      // into "the key is valid and matches the recipient".
      if (
        typeof json.valid !== 'boolean' ||
        (json.network !== 'mainnet' && json.network !== 'testnet') ||
        typeof json.sapling !== 'boolean' ||
        typeof json.orchard !== 'boolean' ||
        (json.address_matches_key !== null && typeof json.address_matches_key !== 'boolean')
      ) {
        throw new EngineUnavailableError(
          'blink-zcash service returned a malformed viewing-key inspection response',
          'unreachable',
        );
      }

      return {
        value: {
          valid: json.valid,
          network: json.network,
          sapling: json.sapling,
          orchard: json.orchard,
          addressMatchesKey:
            json.address_matches_key === null || json.address_matches_key === undefined
              ? null
              : json.address_matches_key,
        },
        authoritative: true,
      };
    },
  };
}
