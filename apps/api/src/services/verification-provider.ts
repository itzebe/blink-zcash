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

import type { TransactionEvidence, ZcashEngine, ShieldedPaymentVerification } from './zcash-engine.js';

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
  /**
   * The public facts decoded from the transaction bytes: the pools it touches
   * and, when an expected recipient was supplied, whether and how much it pays
   * that recipient's transparent receiver. Present only when the authoritative
   * engine actually decoded the bytes. Never synthesized: an absent field means
   * the provider could not establish the composition.
   */
  evidence?: TransactionEvidence;
  /**
   * The cryptographically-grounded shielded-recipient verification, present only
   * when a recipient viewing key was configured and the provider trial-decrypted
   * the transaction with it. This is the only field that can assert a *shielded*
   * recipient was paid. Absent when no key is configured, the transaction has no
   * shielded bundle, or the engine could not decode the bytes — never synthesized.
   */
  shieldedVerification?: ShieldedPaymentVerification;
}

export interface VerifyContext {
  /** A txid the payer claims to have broadcast, if any. May be untrusted. */
  claimedTxid?: string;
  network: ZcashNetwork;
  /**
   * The requested recipient address, when the caller wants the provider to
   * additionally establish whether the transaction pays it. Passed to the engine
   * as `expected_address`; it only ever enables a *stronger* public match (a
   * transparent output), never a claim about a shielded recipient.
   */
  expectedAddress?: string;
  /**
   * The requested amount in zatoshis, when the caller wants the shielded
   * verification to report whether the recovered amount matched exactly.
   */
  expectedZatoshis?: number;
  /**
   * The request's own recipient Unified viewing key, when the requester supplied
   * one. This makes verification multi-user: the key travels with the request
   * instead of relying on a single operator-configured key. When present it
   * takes precedence over any operator-configured key. Server-side only; never
   * logged or returned.
   */
  recipientViewingKey?: string;
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
  /**
   * The recipient's Unified viewing key, when the operator has provisioned one.
   * With it, the provider trial-decrypts the transaction and can assert that the
   * exact requested shielded recipient was paid. Server-side only; never logged.
   */
  recipientViewingKey?: string;
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
 * The `GetLightdInfo.chainName` lightwalletd reports for a network. This is
 * lightwalletd's own naming (not BLINK's): a testnet endpoint answers `test`, a
 * mainnet endpoint answers `main`. Deriving it from the provider's bound network
 * is what keeps a testnet request from ever being satisfied by a mainnet
 * endpoint, and vice versa.
 */
function expectedChainName(network: ZcashNetwork): string {
  return network === 'mainnet' ? 'main' : 'test';
}

/**
 * Real lightwalletd `CompactTxStreamer` provider.
 *
 * It observes a specific transaction the payer reported by calling the standard
 * `GetTransaction` RPC, then:
 *
 *  1. confirms the endpoint really serves the configured network (via
 *     `GetLightdInfo.chainName`), so a mainnet endpoint can never satisfy a
 *     testnet request and vice versa;
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
  private readonly recipientViewingKey?: string;
  private readonly clientFactory: LightwalletdClientFactory;

  constructor(private readonly options: LightwalletdOptions) {
    const { target, tls } = parseTarget(options.url);
    this.target = target;
    this.credentials = tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.network = options.network ?? 'testnet';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.engine = options.engine;
    this.recipientViewingKey = options.recipientViewingKey?.trim() || undefined;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  private async unary<T>(
    invoke: (callback: UnaryCallback<T>) => grpc.ClientUnaryCall,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      invoke((error, response) => (error ? reject(error) : resolve(response)));
    });
  }

  /**
   * Decode the returned bytes with the authoritative engine and return both the
   * real txid and the public evidence (pools, transparent-recipient match). A
   * single decode keeps the txid binding and the evidence derived from exactly
   * the same bytes. Returns `null` when no authoritative decoder is configured
   * or the bytes cannot be decoded — in which case BLINK reports nothing rather
   * than guessing the transaction's composition.
   */
  private async authoritativeEvidence(
    data: Buffer,
    expectedAddress: string | undefined,
  ): Promise<{ txid: string; evidence: TransactionEvidence } | null> {
    if (!this.engine || !this.engine.configured) return null;
    try {
      const result = await this.engine.inspectTransaction(data.toString('hex'), {
        network: this.network,
        ...(expectedAddress ? { expectedAddress } : {}),
      });
      return { txid: result.value.txid.toLowerCase(), evidence: result.value };
    } catch {
      return null;
    }
  }

  /**
   * Trial-decrypt the returned bytes with the recipient's viewing key, when one
   * is configured and an expected recipient is known. This is the only path that
   * can assert a *shielded* recipient was paid. Returns `undefined` (never a
   * synthesized result) when there is no key, no expected address, the bytes have
   * no shielded bundle, or the engine cannot decode them. The engine itself
   * refuses to credit a recipient unless a recovered note's address is byte-for-
   * byte the requested one and the computed txid matches the claim.
   */
  private async shieldedRecipientVerification(
    data: Buffer,
    expectedAddress: string | undefined,
    expectedZatoshis: number | undefined,
    expectedTxid: string | undefined,
    requestViewingKey: string | undefined,
  ): Promise<ShieldedPaymentVerification | undefined> {
    if (!this.engine || !this.engine.configured) return undefined;
    // A per-request key (multi-user) takes precedence over the operator's
    // configured key; either can verify the recipient of the transaction.
    const viewingKey = requestViewingKey?.trim() || this.recipientViewingKey;
    if (!viewingKey || !expectedAddress) return undefined;
    try {
      const result = await this.engine.verifyShielded(data.toString('hex'), {
        network: this.network,
        viewingKey,
        expectedAddress,
        ...(expectedZatoshis !== undefined ? { expectedZatoshis } : {}),
        // Bind the decoded bytes to the observed txid at the engine level too, so
        // a recipient match can never be credited against a different
        // transaction than the one the provider observed.
        ...(expectedTxid ? { expectedTxid } : {}),
      });
      return result.value;
    } catch {
      // A wrong-network key, a malformed key, or bytes the engine cannot decode:
      // report no shielded verification rather than guessing. The public evidence
      // path still stands on its own.
      return undefined;
    }
  }

  async observe(context: VerifyContext): Promise<Observation | null> {
    const { claimedTxid, network, expectedAddress, expectedZatoshis, recipientViewingKey } =
      context;
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
      if (chainName !== expectedChainName(this.network)) return null;

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

      // 4. Bind the bytes to the claim and derive the public evidence using the
      //    authoritative decoder. The evidence is what lets a caller distinguish a
      //    transparent settlement from a shielded one.
      const decoded = await this.authoritativeEvidence(data, expectedAddress);
      if (!decoded || decoded.txid !== claimedTxid.toLowerCase()) return null;
      const { txid, evidence } = decoded;

      const heightRaw = raw?.height;
      const heightStr = heightRaw == null ? '' : String(heightRaw);
      const minedHeight = toNumber(heightRaw);
      const minedOnBestChain =
        heightStr !== '' &&
        heightStr !== OFF_CHAIN_SENTINEL &&
        minedHeight > 0 &&
        tipHeight >= minedHeight;
      const confirmations = minedOnBestChain ? tipHeight - minedHeight + 1 : 0;

      // When a recipient viewing key is configured, additionally trial-decrypt
      // the transaction to establish whether the exact requested shielded
      // recipient was paid. Absent without a key; never synthesized.
      const shieldedVerification = await this.shieldedRecipientVerification(
        data,
        expectedAddress,
        expectedZatoshis,
        txid,
        recipientViewingKey,
      );

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
        evidence,
        ...(shieldedVerification ? { shieldedVerification } : {}),
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
  recipientViewingKey?: string;
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
        ...(config.recipientViewingKey ? { recipientViewingKey: config.recipientViewingKey } : {}),
      });
    case 'none':
    default:
      return new NullProvider();
  }
}
