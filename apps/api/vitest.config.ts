import { defineConfig } from 'vitest/config';

/**
 * API test configuration.
 *
 * The API tests are integration tests: they run the real Fastify app against a
 * real PostgreSQL database and truncate shared tables between tests. Vitest runs
 * test files in parallel by default, which let two DB-backed files truncate each
 * other's rows mid-test. Files must therefore run one at a time; tests within a
 * file already run sequentially.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
