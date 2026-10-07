/**
 * Startup-path regression tests for the free-tier cold-start incident.
 *
 * The API start command runs `migrate.js` and then `server.js`. If either waits
 * forever on an unreachable database, the HTTP server never listens and even the
 * liveness endpoint fails. These tests pin the bounds that prevent that: the
 * pooled connection timeout and the migration connect/statement timeouts must be
 * finite, and a dead database must fail fast rather than hang.
 */
import { describe, expect, it } from 'vitest';

import { createDb, DB_CONNECTION_TIMEOUT_MS } from '../db/index.js';
import { migrate } from '../db/migrate.js';

describe('database pool timeouts', () => {
  it('bounds connection acquisition so a dead database cannot hang a probe', () => {
    const { pool } = createDb('postgres://user:pw@127.0.0.1:5432/unused');
    try {
      // node-postgres defaults this to 0 ("wait forever"); the fix sets a finite
      // bound. A regression here would reintroduce an indefinite /ready hang.
      expect(pool.options.connectionTimeoutMillis).toBe(DB_CONNECTION_TIMEOUT_MS);
      expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
    } finally {
      void pool.end();
    }
  });
});

describe('migrate timeouts', () => {
  it('fails fast instead of hanging when the database is unreachable', async () => {
    // Port 1 refuses immediately. The point is that migrate() *returns* (rejects)
    // rather than hanging the boot forever; the bound makes even a black-holed
    // host give up eventually.
    await expect(migrate('postgres://user:pw@127.0.0.1:1/unreachable')).rejects.toBeDefined();
  }, 20_000);
});
