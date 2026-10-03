/**
 * Blockchain verification providers.
 *
 * BLINK is built on one rule: it never invents blockchain state. A provider
 * either observes a transaction through legitimate Zcash infrastructure and
 * returns exactly what it saw, or it returns nothing and BLINK reports an
 * unknown/absent state.
 *
 * No provider here can create a transaction, sign anything, or fabricate a txid.
 *
 * Reality check on shielded payments
 * ----------------------------------
 * For shielded (Sapling/Orchard/Unified) recipients, the amount and recipient
 * are not public. A third party cannot prove "address X sent exactly N ZEC" from
 * a public explorer. BLINK therefore does not pretend to. Verification is
 * designed around what the wallet/payment integration can legitimately observe:
 *
 *  * With a full node or lightwalletd that has the recipient's viewing key, the
 *    wallet can detect the note and prove the payment to itself.
 *  * Without that, BLINK can only confirm that a specific transaction the payer
 *    reported has been mined and reached the required confirmation depth.
 *
 * `none` is the default. It reports UNKNOWN, which is the truthful answer when no
 * observation infrastructure is configured.
 */
import type { ZcashNetwork } from '@blink/shared';

export interface Observation {
  /** The transaction id, exactly as returned by the provider. */
  txid: string;
  /** Number of confirmations, exactly as returned by the provider. */
  confirmations: number;
  /** Whether the provider considers the transaction broadcast/mined. */
  broadcast: boolean;
  blockHeight?: number;
  /** Identifier of the provider that produced this observation. */
  source: string;
  /** Redacted provider payload, kept for auditability. */
  raw?: Record<string, unknown>;
}

export interface VerifyContext {
  /** A txid the payer claims to have broadcast, if any. May be untrusted. */
  claimedTxid?: string;
  network: ZcashNetwork;
}

export interface VerificationProvider {
  readonly name: string;
  /**
   * Observe a transaction. Returns `null` when the provider has no knowledge of
   * the transaction (or when no verification infrastructure is configured). It
   * must never return a synthesized observation.
   */
  observe(context: VerifyContext): Promise<Observation | null>;
}

/** The honest default: BLINK has no verification infrastructure configured. */
export class NullProvider implements VerificationProvider {
  readonly name = 'none';

  async observe(): Promise<Observation | null> {
    return null;
  }
}

export interface RpcProviderOptions {
  url: string;
  user: string;
  password: string;
}

/**
 * Full-node JSON-RPC provider (`getrawtransaction`, `getblockcount`).
 *
 * Enabled only when `BLINK_VERIFICATION_PROVIDER=node-rpc` and `ZCASH_RPC_URL`
 * are configured. Credentials are supplied by the operator and never logged.
 */
export class NodeRpcProvider implements VerificationProvider {
  readonly name = 'node-rpc';

  constructor(private readonly options: RpcProviderOptions) {}

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const auth = Buffer.from(`${this.options.user}:${this.options.password}`).toString('base64');
    const res = await fetch(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'blink', method, params }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Zcash RPC authentication failed');
    }
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(`Zcash RPC error: ${json.error.message ?? 'unknown'}`);
    return json.result as T;
  }

  async observe(context: VerifyContext): Promise<Observation | null> {
    if (!context.claimedTxid) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(context.claimedTxid)) return null;

    try {
      const tx = await this.rpc<{ txid?: string; confirmations?: number; blockheight?: number }>(
        'getrawtransaction',
        [context.claimedTxid, 1],
      );
      if (!tx || !tx.txid) return null;
      const confirmations =
        typeof tx.confirmations === 'number' ? Math.max(0, tx.confirmations) : 0;
      return {
        txid: tx.txid,
        confirmations,
        broadcast: true,
        blockHeight: typeof tx.blockheight === 'number' ? tx.blockheight : undefined,
        source: this.name,
        raw: { confirmations, blockheight: tx.blockheight },
      };
    } catch {
      // The node did not recognise the transaction. Do not guess: report nothing.
      return null;
    }
  }
}

export interface LightwalletdOptions {
  url: string;
}

/**
 * lightwalletd gRPC provider.
 *
 * A full lightwalletd integration requires a gRPC client and, for shielded
 * detection, the recipient's viewing key. That is out of scope for this MVP, so
 * this provider is intentionally a documented stub: it refuses to report
 * anything rather than fabricate an observation. Wiring it up is tracked in the
 * roadmap (see README).
 */
export class LightwalletdProvider implements VerificationProvider {
  readonly name = 'lightwalletd';

  constructor(private readonly options: LightwalletdOptions) {
    void this.options;
  }

  async observe(): Promise<Observation | null> {
    return null;
  }
}

export function createVerificationProvider(config: {
  provider: 'none' | 'lightwalletd' | 'node-rpc';
  lightwalletdUrl: string;
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
}): VerificationProvider {
  switch (config.provider) {
    case 'node-rpc':
      if (!config.rpcUrl) return new NullProvider();
      return new NodeRpcProvider({
        url: config.rpcUrl,
        user: config.rpcUser,
        password: config.rpcPassword,
      });
    case 'lightwalletd':
      if (!config.lightwalletdUrl) return new NullProvider();
      return new LightwalletdProvider({ url: config.lightwalletdUrl });
    case 'none':
    default:
      return new NullProvider();
  }
}
