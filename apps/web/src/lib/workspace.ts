/**
 * Per-device merchant workspace.
 *
 * BLINK has no server-side accounts by design (see AGENTS.md: there is no
 * owner-scoped route without a real auth model). The one credential a merchant
 * holds is the per-request management token returned once at creation, which the
 * API stores only as a hash. This module keeps those tokens, and the short codes
 * they belong to, in this browser's localStorage.
 *
 * Consequences, stated honestly in the UI:
 *   - the workspace is per device and per browser; it is not an account,
 *   - clearing site data removes it,
 *   - the short code (not the token) is what makes a request shareable, and the
 *     short code alone never grants the management actions (cancel).
 *
 * Nothing here invents server state: every value shown in the workspace is
 * re-fetched from the public payment-request projection.
 */

export const MANAGE_KEY_PREFIX = 'blink:manage:';

const INDEX_KEY = 'blink:workspace:requests';

export interface WorkspaceEntry {
  shortCode: string;
  /** Human label captured at creation, for the workspace list. */
  label: string;
  createdAt: string;
}

function storage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    // Fall back to a host-provided storage (used by tests running in Node).
    const g = globalThis as { localStorage?: Storage };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readManagementToken(shortCode: string): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(`${MANAGE_KEY_PREFIX}${shortCode}`);
  } catch {
    return null;
  }
}

/** Persist the management token for a created request (idempotent). */
export function saveManagementToken(shortCode: string, token: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(`${MANAGE_KEY_PREFIX}${shortCode}`, token);
  } catch {
    /* storage may be unavailable or full; not fatal */
  }
}

function readIndex(): WorkspaceEntry[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is WorkspaceEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as WorkspaceEntry).shortCode === 'string' &&
        typeof (e as WorkspaceEntry).label === 'string',
    );
  } catch {
    return [];
  }
}

function writeIndex(entries: WorkspaceEntry[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(INDEX_KEY, JSON.stringify(entries));
  } catch {
    /* not fatal */
  }
}

/** Remember a request in this device's workspace, most recent first. */
export function addWorkspaceEntry(entry: WorkspaceEntry): void {
  const existing = readIndex().filter((e) => e.shortCode !== entry.shortCode);
  writeIndex([entry, ...existing].slice(0, 100));
}

export function listWorkspaceEntries(): WorkspaceEntry[] {
  return readIndex();
}

/** Remove a request from the workspace index (does not touch the token). */
export function removeWorkspaceEntry(shortCode: string): void {
  writeIndex(readIndex().filter((e) => e.shortCode !== shortCode));
}
