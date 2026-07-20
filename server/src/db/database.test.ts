// Schema + pragma + idempotency tests for the SQLite anchor store.
//
// Central to this file is the AC2 exact-column invariant: the `projects` table
// persists ONLY thin anchors — its column set must be EXACTLY
// {path, display_name, pinned, ui_prefs_json, created_at}, no more, no less.
// A drift in either direction (a stray derived column, or a dropped anchor
// field) fails the build here before it can reach the store.

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from './database.js';

// Tmp DB files created during a test, cleaned up in afterEach (with the WAL/SHM
// sidecar files SQLite creates alongside them).
const createdPaths: string[] = [];

function newTmpDbPath(): string {
  const path = join(tmpdir(), `devos-dbtest-${randomUUID()}.db`);
  createdPaths.push(path);
  return path;
}

afterEach(() => {
  while (createdPaths.length > 0) {
    const path = createdPaths.pop()!;
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }
});

describe('openDatabase — schema invariants', () => {
  it('AC2: projects has EXACTLY the thin-anchor columns, no more, no less', () => {
    const handle = openDatabase(':memory:');
    try {
      const columns = handle.raw
        .pragma('table_info(projects)') as Array<{ name: string }>;
      const names = columns.map((c) => c.name).sort();

      expect(names).toEqual(
        ['created_at', 'display_name', 'path', 'pinned', 'ui_prefs_json'].sort(),
      );
    } finally {
      handle.close();
    }
  });

  it('creates all four tables (projects, sessions, cost_ledger, ui_state)', () => {
    const handle = openDatabase(':memory:');
    try {
      const rows = handle.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>;
      const tables = new Set(rows.map((r) => r.name));

      for (const expected of ['projects', 'sessions', 'cost_ledger', 'ui_state']) {
        expect(tables.has(expected)).toBe(true);
      }
    } finally {
      handle.close();
    }
  });
});

describe('openDatabase — pragmas (file-backed DB)', () => {
  it('enables WAL journaling and foreign-key enforcement', () => {
    // A file DB is required: :memory: reports journal_mode 'memory', not 'wal'.
    const handle = openDatabase(newTmpDbPath());
    try {
      const journalMode = handle.raw.pragma('journal_mode', { simple: true });
      const foreignKeys = handle.raw.pragma('foreign_keys', { simple: true });

      expect(journalMode).toBe('wal');
      expect(foreignKeys).toBe(1);
    } finally {
      handle.close();
    }
  });
});

describe('openDatabase — idempotent DDL', () => {
  it('re-opening the same file does not throw and preserves data', () => {
    const path = newTmpDbPath();
    const createdAt = Date.now();

    const first = openDatabase(path);
    first.raw
      .prepare(`INSERT INTO projects (path, created_at) VALUES (?, ?)`)
      .run('/tmp/some/project', createdAt);
    first.close();

    // Re-running CREATE TABLE IF NOT EXISTS against an existing DB must not throw.
    let second: ReturnType<typeof openDatabase> | undefined;
    expect(() => {
      second = openDatabase(path);
    }).not.toThrow();

    try {
      const row = second!.raw
        .prepare(`SELECT path, created_at FROM projects WHERE path = ?`)
        .get('/tmp/some/project') as { path: string; created_at: number } | undefined;

      expect(row).toEqual({ path: '/tmp/some/project', created_at: createdAt });
    } finally {
      second?.close();
    }
  });
});
