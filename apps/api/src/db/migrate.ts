/**
 * Database migration.
 *
 * Kept as explicit, idempotent SQL so the schema is transparent and reviewable
 * without a code generator. Run with `npm run db:migrate -w @blink/api`.
 */
import pg from 'pg';
import { loadConfig } from '../config.js';

const DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text,
  public_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_idx ON users (handle);

CREATE TABLE IF NOT EXISTS payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code text NOT NULL,
  recipient_name text NOT NULL,
  recipient_address_encrypted text NOT NULL,
  recipient_address_kind text,
  recipient_address_fingerprint text,
  amount text NOT NULL,
  currency text NOT NULL DEFAULT 'ZEC',
  purpose text NOT NULL DEFAULT 'invoice',
  usd_amount text,
  zec_usd_price text,
  price_provider text,
  price_observed_at timestamptz,
  memo text,
  label text,
  message text,
  network text NOT NULL,
  privacy jsonb,
  zip321_uri text NOT NULL,
  status text NOT NULL DEFAULT 'CREATED',
  claimed_txid text,
  claimed_at timestamptz,
  txid text,
  confirmations integer NOT NULL DEFAULT 0,
  owner_id uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_short_code_idx ON payment_requests (short_code);
CREATE INDEX IF NOT EXISTS payment_requests_status_idx ON payment_requests (status);
CREATE INDEX IF NOT EXISTS payment_requests_owner_idx ON payment_requests (owner_id);

-- Additive migrations for databases created before USD-denominated requests.
-- Idempotent so this file can run on every start.
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS usd_amount text;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS zec_usd_price text;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS price_provider text;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS price_observed_at timestamptz;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS privacy jsonb;
-- Additive migration for the everyday-workflow label (invoice, payroll, …).
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'invoice';

CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id uuid NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_events_request_idx ON payment_events (payment_request_id);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id uuid NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  txid text NOT NULL,
  confirmations integer NOT NULL DEFAULT 0,
  broadcast boolean NOT NULL DEFAULT false,
  block_height integer,
  source text NOT NULL,
  raw_observation jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_txid_idx ON transactions (txid);
CREATE INDEX IF NOT EXISTS transactions_request_idx ON transactions (payment_request_id);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions (token_hash);
`;

/** Bound on connecting/querying so the start command can never hang forever. */
const MIGRATION_CONNECTION_TIMEOUT_MS = 15_000;
const MIGRATION_STATEMENT_TIMEOUT_MS = 30_000;

export async function migrate(connectionString: string): Promise<void> {
  const client = new pg.Client({
    connectionString,
    // The API start command runs this before `server.js`. Without a bound, an
    // unreachable database (a cold Render Free instance, a Neon cold start)
    // would hang the whole boot, so the HTTP server would never listen and every
    // request — including liveness — would fail. Bound both the connect and the
    // statement so a dead database fails fast and loudly instead of hanging.
    connectionTimeoutMillis: MIGRATION_CONNECTION_TIMEOUT_MS,
    statement_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    await client.query(DDL);
  } finally {
    await client.end();
  }
}

const isDirectRun =
  process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');
if (isDirectRun) {
  const config = loadConfig();
  const target = new URL(config.DATABASE_URL);
  // Never log credentials.
  console.log(`Applying BLINK migrations to ${target.host}${target.pathname}`);
  migrate(config.DATABASE_URL)
    .then(() => {
      console.log('Migrations applied.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
