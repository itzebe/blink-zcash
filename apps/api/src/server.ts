/**
 * BLINK API server.
 *
 * Wires configuration, database, encryption, the Zcash engine client, the
 * verification provider and the payment service into a Fastify application.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadConfig, type AppConfig } from './config.js';
import { createCrypto, type Crypto } from './crypto.js';
import { createDb, type Database } from './db/index.js';
import { PaymentService } from './services/payment-service.js';
import { createZcashEngine, type ZcashEngine } from './services/zcash-engine.js';
import {
  createVerificationProvider,
  type VerificationProvider,
} from './services/verification-provider.js';
import { createZecUsdPriceProvider, type ZecUsdPriceProvider } from './services/price-service.js';
import { createReadinessChecker, type ReadinessChecker } from './services/readiness.js';
import { registerRoutes, type RouteDeps } from './routes/index.js';

export interface BuildAppOptions {
  config?: AppConfig;
  db?: Database;
  crypto?: Crypto;
  engine?: ZcashEngine;
  provider?: VerificationProvider;
  priceProvider?: ZecUsdPriceProvider;
  now?: () => Date;
  generateCode?: () => string;
}

export interface BuiltApp {
  app: FastifyInstance;
  service: PaymentService;
  config: AppConfig;
  db: Database;
  crypto: Crypto;
  readiness: ReadinessChecker;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const crypto = options.crypto ?? createCrypto(config.BLINK_ENCRYPTION_KEY, config.isProduction);
  const { db, pool } = options.db ? { db: options.db, pool: null } : createDb(config.DATABASE_URL);

  const engine =
    options.engine ?? createZcashEngine(config.BLINK_ZCASH_SERVICE_URL, config.BLINK_ZCASH_TIMEOUT_MS);
  const provider =
    options.provider ??
    createVerificationProvider({
      provider: config.BLINK_VERIFICATION_PROVIDER,
      lightwalletdUrl: config.BLINK_LIGHTWALLETD_URL,
      rpcUrl: config.ZCASH_RPC_URL,
      rpcUser: config.ZCASH_RPC_USER,
      rpcPassword: config.ZCASH_RPC_PASSWORD,
      network: config.ZCASH_NETWORK,
      engine,
    });

  const priceProvider =
    options.priceProvider ??
    createZecUsdPriceProvider({
      BLINK_PRICE_PROVIDER: config.BLINK_PRICE_PROVIDER,
      COINMARKETCAP_API_KEY: config.COINMARKETCAP_API_KEY,
      BLINK_PRICE_CACHE_TTL_MS: config.BLINK_PRICE_CACHE_TTL_MS,
      BLINK_PRICE_TIMEOUT_MS: config.BLINK_PRICE_TIMEOUT_MS,
    });

  const service = new PaymentService({
    db,
    crypto,
    engine,
    provider,
    priceProvider,
    network: config.ZCASH_NETWORK,
    confirmationsRequired: config.BLINK_CONFIRMATIONS_REQUIRED,
    ...(options.now ? { now: options.now } : {}),
    ...(options.generateCode ? { generateCode: options.generateCode } : {}),
  });

  const readiness = createReadinessChecker({
    db,
    engine,
    network: config.ZCASH_NETWORK,
  });

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      // Never log request bodies or headers wholesale: they can carry secrets.
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-blink-management-token"]',
      ],
    },
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  });
  await app.register(rateLimit, {
    max: config.BLINK_RATE_LIMIT_MAX,
    timeWindow: config.BLINK_RATE_LIMIT_WINDOW_MS,
    // The keep-alive endpoint is the designated infrastructure ping. It does no
    // work, so unlimited calls are harmless, and a monitor must never be
    // throttled into a false negative (which would let the free instance idle).
    allowList: (req) => req.url.split('?')[0] === '/health/keepalive',
  });

  const deps: RouteDeps = { service, config, priceProvider, readiness };
  await registerRoutes(app, deps);

  app.setErrorHandler((err: Error, _req, reply) => {
    app.log.error({ err: err.message }, 'unhandled error');
    reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  if (pool) {
    app.addHook('onClose', async () => {
      await pool.end();
    });
  }

  return { app, service, config, db, crypto, readiness };
}

const isDirectRun =
  process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');

if (isDirectRun) {
  buildApp()
    .then(async ({ app, config }) => {
      await app.listen({ port: config.PORT, host: config.HOST });
      app.log.info(
        `BLINK API listening on ${config.HOST}:${config.PORT} (network=${config.ZCASH_NETWORK})`,
      );
    })
    .catch((err) => {
      console.error('Failed to start BLINK API:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
