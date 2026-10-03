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
}

export interface EngineResult<T> {
  value: T;
  /** Whether the authoritative engine confirmed this result. */
  authoritative: boolean;
}

export interface ZcashEngine {
  readonly configured: boolean;
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
}

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

export function createZcashEngine(serviceUrl: string, timeoutMs = 3000): ZcashEngine {
  const configured = serviceUrl.length > 0;

  async function call<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(new URL(path, serviceUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const message = typeof json.error === 'string' ? json.error : 'engine rejected request';
        throw new EngineUnavailableError(message);
      }
      return json as T;
    } catch (err) {
      if (err instanceof EngineUnavailableError) throw err;
      throw new EngineUnavailableError(
        `blink-zcash service unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    configured,

    async inspectAddress(address, network) {
      if (!configured) {
        throw new EngineUnavailableError('BLINK_ZCASH_SERVICE_URL is not configured');
      }
      const json = await call<{
        address: string;
        kind: string;
        network: string;
        can_receive_memo: boolean;
      }>('/v1/address/inspect', { address, network });
      return {
        value: {
          address: json.address,
          kind: json.kind as AddressKind,
          network: json.network as ZcashNetwork,
          canReceiveMemo: json.can_receive_memo,
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
  };
}
