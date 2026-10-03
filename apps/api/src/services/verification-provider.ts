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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { ZcashNetwork } from '@blink/shared';

import type { ZcashEngine } from './zcash-engine.js';

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
  /** Endpoint as supplied by `BLINK_LIGHTWALLETD_URL`. */
  url: string;
  /** Network this provider is bound to. Defaults to testnet. */
  network?: ZcashNetwork;
  /** Per-RPC deadline. Defaults to 10s. */
  timeoutMs?: number;
  /**
   * Authoritative engine used to derive the txid from returned transaction
   * bytes. Without it the provider cannot bind the bytes to the claimed txid and
   * therefore reports nothing rather than guessing.
   */
  engine?: ZcashEngine;
  /** Test seam: build the gRPC client. Never used to bypass verification. */
  clientFactory?: LightwalletdClientFactory;
}

interface RawTransactionReply {
  data?: Uint8Array | Buffer | null;
  height?: string | number | null;
}

interface BlockIdReply {
  height?: string | number | null;
}

interface LightdInfoReply {
  chainName?: string | null;
  blockHeight?: string | number | null;
}

type UnaryCallback<T> = (error: grpc.ServiceError | null, response: T) => void;

interface LightwalletdClient extends grpc.Client {
  GetTransaction(
    req: { hash: Buffer },
    options: grpc.CallOptions,
    callback: UnaryCallback<RawTransactionReply>,
  ): grpc.ClientUnaryCall;
  GetLatestBlock(
    req: Record<string, never>,
    options: grpc.CallOptions,
    callback: UnaryCallback<BlockIdReply>,
  ): grpc.ClientUnaryCall;
  GetLightdInfo(
    req: Record<string, never>,
    options: grpc.CallOptions,
    callback: UnaryCallback<LightdInfoReply>,
  ): grpc.ClientUnaryCall;
}

type LightwalletdClientCtor = new (
  target: string,
  credentials: grpc.ChannelCredentials,
) => LightwalletdClient;

export type LightwalletdClientFactory = (
  target: string,
  credentials: grpc.ChannelCredentials,
) => LightwalletdClient;

/** lightwalletd's conventional gRPC port. */
const LIGHTWALLETD_DEFAULT_PORT = 9067;
/**
 * Sentinel lightwalletd/zcashd use for "mined off the best chain". It is the
 * maximum uint64, which JS numbers cannot represent exactly, so it is compared
 * as a string.
 */
const OFF_CHAIN_SENTINEL = '18446744073709551615';

const SERVICE_PROTO_PATH = fileURLToPath(new URL('../../proto/service.proto', import.meta.url));
const PROTO_INCLUDE_DIR = path.dirname(SERVICE_PROTO_PATH);

let cachedPackage: grpc.GrpcObject | null = null;

function streamerCtor(): LightwalletdClientCtor {
  if (!cachedPackage) {
    const definition = protoLoader.loadSync(SERVICE_PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [PROTO_INCLUDE_DIR],
    });
    cachedPackage = grpc.loadPackageDefinition(definition);
  }
  // The proto package is `cash.z.wallet.sdk.rpc` (see apps/api/proto/service.proto).
  const ns = cachedPackage as unknown as {
    cash: { z: { wallet: { sdk: { rpc: { CompactTxStreamer: LightwalletdClientCtor } } } } };
  };
  return ns.cash.z.wallet.sdk.rpc.CompactTxStreamer;
}

function defaultClientFactory(
  target: string,
  credentials: grpc.ChannelCredentials,
): LightwalletdClient {
  return new (streamerCtor())(target, credentials);
}

/** Parse an endpoint into a gRPC target and whether TLS should be used. */
function parseTarget(rawUrl: string): { target: string; tls: boolean } {
  const trimmed = rawUrl.trim();
  const tls = trimmed.toLowerCase().startsWith('https://');
  const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const withoutPath = withoutScheme.replace(/\/.*$/, '');
  if (!withoutPath) throw new Error('lightwalletd endpoint is empty');
  // Add the conventional port when the operator omitted one.
  const hasPort = /:\d+$/.test(withoutPath);
  return { target: hasPort ? withoutPath : `${withoutPath}:${LIGHTWALLETD_DEFAULT_PORT}`, tls };
}

/** Interpret a protobuf uint64 (string|number) as a JS number, or 0 when absent. */
function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** A claimed txid (big-endian hex) as the little-endian bytes lightwalletd expects. */
function txidToLittleEndian(txid: string): Buffer {
  const bytes = Buffer.from(txid, 'hex');
  return Buffer.from(bytes).reverse();
}

/**
 * Real lightwalletd `CompactTxStreamer` provider.
 *
 * It observes a specific transaction the payer reported by calling the standard
 * `GetTransaction` RPC, then:
 *
 *  1. confirms the endpoint really serves the configured network (via
 *     `GetLightdInfo.chainName`), so a mainnet endpoint can never satisfy a
 *     testnet request;
 *  2. asks for the current tip (`GetLatestBlock`) so it can translate the mined
 *     height returned by lightwalletd into a real confirmation count;
 *  3. decodes the returned raw transaction with the authoritative Zcash engine
 *     and rejects the observation unless the decoded txid matches the claim.
 *
 * Only then does it return an `Observation`. A missing transaction, a gRPC
 * error, a timeout, an unreachable endpoint, a malformed response or a txid that
 * does not match the returned bytes all yield `null`, which the payment service
 * treats as "not observed" and never as a confirmation.
 */
export class LightwalletdProvider implements VerificationProvider {
  readonly name = 'lightwalletd';

  private readonly target: string;
  private readonly credentials: grpc.ChannelCredentials;
  private readonly network: ZcashNetwork;
  private readonly timeoutMs: number;
  private readonly engine?: ZcashEngine;
  private readonly clientFactory: LightwalletdClientFactory;

  constructor(private readonly options: LightwalletdOptions) {
    const { target, tls } = parseTarget(options.url);
    this.target = target;
    this.credentials = tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.network = options.network ?? 'testnet';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.engine = options.engine;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  private async unary<T>(
    invoke: (callback: UnaryCallback<T>) => grpc.ClientUnaryCall,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      invoke((error, response) => (error ? reject(error) : resolve(response)));
    });
  }

  /** Derive the real txid from the returned bytes; null if that is not possible. */
  private async authoritativeTxid(data: Buffer): Promise<string | null> {
    if (!this.engine || !this.engine.configured) return null;
    try {
      const result = await this.engine.decodeTransaction(data.toString('hex'));
      return result.value.txid.toLowerCase();
    } catch {
      return null;
    }
  }

  async observe(context: VerifyContext): Promise<Observation | null> {
    const { claimedTxid, network } = context;
    // Wrong network for this provider: never observe, never guess.
    if (network !== this.network) return null;
    if (!claimedTxid || !/^[0-9a-fA-F]{64}$/.test(claimedTxid)) return null;

    let client: LightwalletdClient | null = null;
    try {
      client = this.clientFactory(this.target, this.credentials);

      // 1. Verify the endpoint serves the network we are configured for.
      const info = await this.unary<LightdInfoReply>((cb) =>
        client!.GetLightdInfo({}, { deadline: Date.now() + this.timeoutMs }, cb),
      );
      const chainName = String(info?.chainName ?? '').toLowerCase();
      if (chainName !== 'test') return null;

      // 2. Fetch the tip so the mined height can become a confirmation count.
      const tip = await this.unary<BlockIdReply>((cb) =>
        client!.GetLatestBlock({}, { deadline: Date.now() + this.timeoutMs }, cb),
      );
      const tipHeight = toNumber(tip?.height);

      // 3. Fetch the transaction the payer claims to have broadcast.
      const raw = await this.unary<RawTransactionReply>((cb) =>
        client!.GetTransaction(
          { hash: txidToLittleEndian(claimedTxid) },
          { deadline: Date.now() + this.timeoutMs },
          cb,
        ),
      );
      const data = raw?.data ? Buffer.from(raw.data) : Buffer.alloc(0);
      if (data.length === 0) return null;

      // 4. Bind the bytes to the claim using the authoritative decoder.
      const txid = await this.authoritativeTxid(data);
      if (!txid || txid !== claimedTxid.toLowerCase()) return null;

      const heightRaw = raw?.height;
      const heightStr = heightRaw == null ? '' : String(heightRaw);
      const minedHeight = toNumber(heightRaw);
      const minedOnBestChain =
        heightStr !== '' &&
        heightStr !== OFF_CHAIN_SENTINEL &&
        minedHeight > 0 &&
        tipHeight >= minedHeight;
      const confirmations = minedOnBestChain ? tipHeight - minedHeight + 1 : 0;

      return {
        txid,
        confirmations,
        // lightwalletd only returns a transaction it knows about, but an unmined
        // one (height 0) is a mempool broadcast rather than a confirmation.
        broadcast: true,
        ...(minedOnBestChain ? { blockHeight: minedHeight } : {}),
        source: this.name,
        raw: {
          chainName,
          tipHeight,
          minedHeight,
          confirmed: confirmations > 0,
          size: data.length,
        },
      };
    } catch {
      // Unreachable endpoint, timeout, gRPC error, malformed response: report
      // nothing. Never synthesize an observation.
      return null;
    } finally {
      if (client) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
    }
  }
}

export function createVerificationProvider(config: {
  provider: 'none' | 'lightwalletd' | 'node-rpc';
  lightwalletdUrl: string;
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
  network?: ZcashNetwork;
  engine?: ZcashEngine;
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
      return new LightwalletdProvider({
        url: config.lightwalletdUrl,
        network: config.network ?? 'testnet',
        ...(config.engine ? { engine: config.engine } : {}),
      });
    case 'none':
    default:
      return new NullProvider();
  }
}
