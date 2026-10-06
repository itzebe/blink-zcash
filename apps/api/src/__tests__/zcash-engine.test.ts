/**
 * Tests for the blink-zcash engine client.
 *
 * These drive the production code path against a real local HTTP server: the
 * client must parse JSON from the engine, surface the engine's own error
 * messages, and — when the configured URL does not reach the engine and a
 * frontend/host HTML page comes back instead — report that plainly rather than
 * throwing a raw JSON parse error.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createZcashEngine, EngineUnavailableError } from '../services/zcash-engine.js';

const servers: Server[] = [];

function startServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) throw new Error('no port');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

const ADDRESS = 'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf';

describe('createZcashEngine', () => {
  it('parses a JSON success response from the engine', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ address: ADDRESS, kind: 'unified', network: 'mainnet', can_receive_memo: true }));
    });
    const engine = createZcashEngine(url);
    const result = await engine.inspectAddress(ADDRESS, 'mainnet');
    expect(result.authoritative).toBe(true);
    expect(result.value.kind).toBe('unified');
    expect(result.value.network).toBe('mainnet');
  });

  it('surfaces the engine JSON error message', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid address: Not a Zcash address', kind: 'invalid_address' }));
    });
    const engine = createZcashEngine(url);
    await expect(engine.inspectAddress('nope', 'mainnet')).rejects.toThrow(
      /invalid address: Not a Zcash address/,
    );
  });

  it('reports a non-JSON (HTML) response as an unreachable engine, not a parse error', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>Not Found</body></html>');
    });
    const engine = createZcashEngine(url);
    const error = await engine.inspectAddress(ADDRESS, 'mainnet').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as Error).message).toMatch(/non-JSON response/);
    expect((error as Error).message).not.toMatch(/Unexpected token/);
  });

  it('reports a connection failure as unreachable', async () => {
    const engine = createZcashEngine('http://127.0.0.1:1');
    await expect(engine.inspectAddress(ADDRESS, 'mainnet')).rejects.toThrow(
      /blink-zcash service unreachable/,
    );
  });
});
