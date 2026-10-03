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
  BLINK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  BLINK_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  BLINK_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
});

export type AppConfig = z.infer<typeof schema> & {
  allowedOrigins: string[];
  isProduction: boolean;
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

  return {
    ...parsed,
    isProduction,
    allowedOrigins: parsed.BLINK_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
