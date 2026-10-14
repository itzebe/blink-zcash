import { beforeEach, describe, expect, it } from 'vitest';

import {
  addWorkspaceEntry,
  listWorkspaceEntries,
  MANAGE_KEY_PREFIX,
  readManagementToken,
  removeWorkspaceEntry,
  saveManagementToken,
} from './workspace.js';

/** A minimal in-memory Storage so the module can be tested under Node. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
});

describe('management token storage', () => {
  it('round-trips a token under the existing key prefix', () => {
    saveManagementToken('ABC123', 'request-id-token');
    expect(readManagementToken('ABC123')).toBe('request-id-token');
    expect(
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(
        `${MANAGE_KEY_PREFIX}ABC123`,
      ),
    ).toBe('request-id-token');
  });

  it('returns null for a request this device never created', () => {
    expect(readManagementToken('NOPE')).toBeNull();
  });
});

describe('workspace index', () => {
  it('adds entries most-recent-first and de-duplicates by short code', () => {
    addWorkspaceEntry({ shortCode: 'A', label: 'One', createdAt: '2026-01-01T00:00:00Z' });
    addWorkspaceEntry({ shortCode: 'B', label: 'Two', createdAt: '2026-01-02T00:00:00Z' });
    addWorkspaceEntry({ shortCode: 'A', label: 'One again', createdAt: '2026-01-03T00:00:00Z' });

    const list = listWorkspaceEntries();
    expect(list.map((e) => e.shortCode)).toEqual(['A', 'B']);
    expect(list[0]!.label).toBe('One again');
  });

  it('removes an entry without touching its token', () => {
    addWorkspaceEntry({ shortCode: 'A', label: 'One', createdAt: '2026-01-01T00:00:00Z' });
    saveManagementToken('A', 'token-a');
    removeWorkspaceEntry('A');
    expect(listWorkspaceEntries()).toEqual([]);
    expect(readManagementToken('A')).toBe('token-a');
  });

  it('survives a corrupt index rather than throwing', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
      'blink:workspace:requests',
      '{not json',
    );
    expect(listWorkspaceEntries()).toEqual([]);
  });

  it('is a no-op when storage is unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(() =>
      addWorkspaceEntry({ shortCode: 'A', label: 'One', createdAt: 'x' }),
    ).not.toThrow();
    expect(listWorkspaceEntries()).toEqual([]);
    expect(readManagementToken('A')).toBeNull();
  });
});
