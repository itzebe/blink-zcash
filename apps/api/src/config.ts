/**
 * Environment configuration for the BLINK API.
 *
 * Every value is read from the environment. No credential or key is ever
 * hard-coded. Mainnet is opt-in and must be requested explicitly; the default is
 * testnet.
 */
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().default('postgres://blink:blink_dev_pw@127.0.0.1:5432/blink'),

  ZCASH_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  NEXT_PUBLIC_NETWORK: z.enum(['testnet', 'mainnet']).optional(),

  /**
   * URL of the `blink-zcash` Rust service. When set, address and URI validation
   * become authoritative. When unset, BLINK falls back to its own structural
   * validation and marks verification accordingly.
   */
  BLINK_ZCASH_SERVICE_URL: z.string().optional().default(''),

  /**
   * Timeout (ms) for a single call to the blink-zcash engine. Must comfortably
   * exceed the engine's cold-start time: the free Render instance can take ~15s
   * to boot, and a timeout below that would turn a waking engine into a
   * spurious failure.
   */
  BLINK_ZCASH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * 32-byte key, hex encoded, used to encrypt recipient addresses at rest
   * (AES-256-GCM). Required in production.
   */
  BLINK_ENCRYPTION_KEY: z.string().optional().default(''),

  /**
   * Provider used by the verification layer. `none` reports UNKNOWN and never
   * fabricates a transaction.
   */
  BLINK_VERIFICATION_PROVIDER: z.enum(['none', 'lightwalletd', 'node-rpc']).default('none'),

  BLINK_LIGHTWALLETD_URL: z.string().optional().default(''),
  ZCASH_RPC_URL: z.string().optional().default(''),
  ZCASH_RPC_USER: z.string().optional().default(''),
  ZCASH_RPC_PASSWORD: z.string().optional().default(''),

  BLINK_CONFIRMATIONS_REQUIRED: z.coerce.number().int().min(0).default(1),

  /**
   * Live ZEC/USD price source used to convert USD-denominated requests into the
   * ZEC amount that ZIP 321 carries.
   *
   *   coinmarketcap -> live ZEC/USD from CoinMarketCap (requires the key below).
   *   coingecko     -> live ZEC/USD from CoinGecko (keyless).
   *   coinbase      -> live ZEC/USD from Coinbase spot (keyless).
   *   auto          -> resilient chain: prefers CoinMarketCap when a key is
   *                    configured, otherwise Coinbase then CoinGecko.
   *   none          -> USD requests are refused; ZEC requests still work.
   *
   * When unset (or blank, as `.env.example` ships it), the provider is
   * auto-selected: CoinMarketCap if an API key is present, otherwise the keyless
   * `auto` chain. `auto` itself prefers CoinMarketCap when a key is present and
   * otherwise falls back to the keyless chain. Either way the rate is a real live
   * observation, never a fabricated fallback.
   */
  BLINK_PRICE_PROVIDER: z
    .preprocess(
      // An empty value is the documented "not set" state, not an invalid enum
      // member: a blank `BLINK_PRICE_PROVIDER=` must auto-select rather than
      // refuse to boot. Whitespace is trimmed for the same reason.
      (value) => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return trimmed === '' ? undefined : trimmed;
      },
      z.enum(['none', 'coinmarketcap', 'coingecko', 'coinbase', 'auto']).optional(),
    ),
  /** CoinMarketCap API key. Server-side only; never exposed to the browser. */
  COINMARKETCAP_API_KEY: z
    .string()
    .optional()
    .default('')
    .transform((value) => value.trim()),
  BLINK_PRICE_CACHE_TTL_MS: z.coerce.number().int().min(0).default(60_000),
  BLINK_PRICE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  BLINK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  BLINK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  BLINK_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
});

export type AppConfig = z.infer<typeof schema> & {
  allowedOrigins: string[];
  isProduction: boolean;
  /** Always resolved by {@link loadConfig} (auto-selected when unset). */
  BLINK_PRICE_PROVIDER: 'none' | 'coinmarketcap' | 'coingecko' | 'coinbase' | 'auto';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);

  if (parsed.NEXT_PUBLIC_NETWORK && parsed.NEXT_PUBLIC_NETWORK !== parsed.ZCASH_NETWORK) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK (${parsed.NEXT_PUBLIC_NETWORK}) must match ZCASH_NETWORK (${parsed.ZCASH_NETWORK})`,
    );
  }

  const isProduction = parsed.NODE_ENV === 'production';

  if (isProduction) {
    // A production process must never silently fall back to the localhost
    // development default; that would point a live deployment at a database that
    // does not exist (or, worse, a local one). Require an explicit DATABASE_URL.
    if (!env.DATABASE_URL || env.DATABASE_URL.trim() === '') {
      throw new Error('DATABASE_URL is required in production');
    }
    if (!parsed.BLINK_ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(parsed.BLINK_ENCRYPTION_KEY)) {
      throw new Error(
        'BLINK_ENCRYPTION_KEY must be a 32-byte hex string in production (64 hex chars)',
      );
    }
    if (parsed.ZCASH_NETWORK === 'mainnet' && parsed.BLINK_VERIFICATION_PROVIDER === 'none') {
      throw new Error(
        'Mainnet requires BLINK_VERIFICATION_PROVIDER to be configured; refusing to run blind',
      );
    }
  }

  // A named provider with no endpoint would silently degrade to "observe
  // nothing". Refuse in every environment, so the operator knows verification is
  // not actually configured.
  if (parsed.BLINK_VERIFICATION_PROVIDER === 'lightwalletd' && !parsed.BLINK_LIGHTWALLETD_URL) {
    throw new Error('BLINK_VERIFICATION_PROVIDER=lightwalletd requires BLINK_LIGHTWALLETD_URL');
  }
  if (parsed.BLINK_VERIFICATION_PROVIDER === 'node-rpc' && !parsed.ZCASH_RPC_URL) {
    throw new Error('BLINK_VERIFICATION_PROVIDER=node-rpc requires ZCASH_RPC_URL');
  }

  // Resolve the effective price provider. When unset/blank the provider is
  // auto-selected: CoinMarketCap if a key is present, otherwise the keyless
  // `auto` chain. `auto` itself is a resilient chain that prefers CoinMarketCap
  // when a key is configured (so a deployment that provisions the key actually
  // uses it) and otherwise falls back to the keyless sources, without ever
  // inventing a price.
  const hasCmcKey = parsed.COINMARKETCAP_API_KEY.length > 0;
  let priceProvider = parsed.BLINK_PRICE_PROVIDER ?? (hasCmcKey ? 'coinmarketcap' : 'auto');
  if (priceProvider === 'coinmarketcap' && !hasCmcKey) {
    if (isProduction) {
      // Never take the whole API down (ZEC requests must keep working) over a
      // missing price key. Disable USD instead; /health reports
      // `priceProvider: none` and USD requests fail with an explicit 503. Adding
      // the key turns USD back on with no redeploy of code.
      priceProvider = 'none';
    } else {
      // A developer asking for CoinMarketCap with no key is a misconfiguration;
      // fail loudly so it is fixed rather than silently ignored.
      throw new Error('BLINK_PRICE_PROVIDER=coinmarketcap requires COINMARKETCAP_API_KEY');
    }
  }

  // A real mainnet deployment must price USD requests from the configured,
  // authoritative source, or not price them at all. Refuse to run mainnet in
  // production with a keyless or `auto` price provider, so a mainnet USD request
  // can never be silently priced from an unconfigured source. `none` is allowed:
  // it disables USD requests (they return 503) while ZEC requests keep working.
  if (
    isProduction &&
    parsed.ZCASH_NETWORK === 'mainnet' &&
    priceProvider !== 'coinmarketcap' &&
    priceProvider !== 'none'
  ) {
    throw new Error(
      'Mainnet requires BLINK_PRICE_PROVIDER=coinmarketcap (with COINMARKETCAP_API_KEY) ' +
        `or none; refusing to price USD requests from "${priceProvider}"`,
    );
  }

  return {
    ...parsed,
    BLINK_PRICE_PROVIDER: priceProvider,
    isProduction,
    allowedOrigins: parsed.BLINK_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
