import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];

/**
 * Bound on acquiring a pooled connection.
 *
 * node-postgres defaults `connectionTimeoutMillis` to 0, which means "wait
 * forever". On a cold Render Free instance a dead or unreachable database would
 * then hang a readiness probe (`/ready` runs `select 1`) indefinitely, so the
 * service could never report a truthful readiness state. A finite bound turns
 * that into a fast, honest `database: false` and lets the readiness check
 * return instead of hanging.
 */
export const DB_CONNECTION_TIMEOUT_MS = 10_000;

export function createDb(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export { schema };
export * from './schema.js';
