/**
 * API readiness.
 *
 * Liveness and readiness are deliberately separate:
 *
 *  * **Liveness** (`/health`) answers "is the process up?". Render uses it to
 *    decide whether to restart the instance. It must stay cheap and must not
 *    depend on external services, or a slow dependency would make Render kill a
 *    perfectly healthy process.
 *
 *  * **Readiness** (`/ready`) answers "can this process actually serve BLINK
 *    right now?". It checks the dependencies a request needs — the database and
 *    the authoritative Zcash engine — and reports `starting` until they are
 *    usable. It is an operational probe (Render health checks, the keep-warm
 *    workflow, an operator); the web app confirms its network through
 *    `/v1/meta/network` instead.
 *
 * Readiness never fakes success: an unreachable engine reports `starting`, not
 * `ready`, so an operator can tell "still coming up" from "actually serving".
 */
import { sql } from 'drizzle-orm';
import type { ZcashNetwork } from '@blink/shared';

import type { Database } from '../db/index.js';
import type { ZcashEngine } from './zcash-engine.js';

export interface ReadinessReport {
  status: 'ready' | 'starting';
  ready: boolean;
  network: ZcashNetwork;
  checks: {
    database: boolean;
    /** `null` when no engine is configured (local development without the engine). */
    engine: boolean | null;
  };
}

export interface ReadinessDeps {
  db: Database;
  engine: ZcashEngine;
  network: ZcashNetwork;
  /**
   * Timeout for the engine liveness ping. Kept short so `/ready` answers quickly
   * while the engine is still cold-starting, instead of holding the request open.
   */
  enginePingTimeoutMs?: number;
}

export type ReadinessChecker = () => Promise<ReadinessReport>;

export function createReadinessChecker(deps: ReadinessDeps): ReadinessChecker {
  const pingTimeoutMs = deps.enginePingTimeoutMs ?? 3_000;
  // Coalesce concurrent checks so a burst of `/ready` calls (many tabs, a
  // keep-warm ping) shares one database query and one engine ping instead of
  // stampeding the dependencies.
  let inFlight: Promise<ReadinessReport> | null = null;

  async function check(): Promise<ReadinessReport> {
    let database = false;
    try {
      await deps.db.execute(sql`select 1`);
      database = true;
    } catch {
      database = false;
    }

    // With no engine configured (local development), readiness depends only on
    // the database. When one is configured it must answer, or the API is not
    // ready to validate addresses authoritatively.
    const engine = deps.engine.configured ? await deps.engine.ping(pingTimeoutMs) : null;
    const ready = database && engine !== false;

    return {
      status: ready ? 'ready' : 'starting',
      ready,
      network: deps.network,
      checks: { database, engine },
    };
  }

  return () => {
    if (inFlight) return inFlight;
    inFlight = check().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
