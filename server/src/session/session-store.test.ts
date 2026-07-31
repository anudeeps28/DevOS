// Unit tests — SessionStore round-trips + the idempotent additive migration.
//
// Uses a real in-memory DB (openDatabase(':memory:')). Because `sessions` has a
// FK to projects(path) with foreign_keys ON, each test seeds a project anchor
// via the registry before inserting sessions.

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase } from '../db/database.js';
import { createRegistry } from '../registry/registry.js';
import { createSessionStore } from './session-store.js';

const PROJECT = '/tmp/devos-fixture-project';

function freshStore(): { store: ReturnType<typeof createSessionStore>; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(':memory:');
  // Seed the project anchor so the sessions FK is satisfied.
  createRegistry(db).pin(PROJECT);
  return { store: createSessionStore(db), db };
}

describe('SessionStore', () => {
  it('insert → list round-trip preserves role and all fields', () => {
    const { store } = freshStore();
    const row = store.insert({
      id: 'sess-1',
      projectPath: PROJECT,
      role: 'builder',
      status: 'running',
      workItemId: 'WI-42',
      currentStage: 'build',
    });
    expect(row.id).toBe('sess-1');
    expect(row.role).toBe('builder');
    expect(row.status).toBe('running');
    expect(row.projectPath).toBe(PROJECT);
    expect(row.workItemId).toBe('WI-42');
    expect(row.currentStage).toBe('build');
    expect(row.sdkSessionId).toBeNull();
    expect(row.createdAt).toBeGreaterThan(0);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.role).toBe('builder');
  });

  it('optional fields default to null when absent', () => {
    const { store } = freshStore();
    const row = store.insert({
      id: 'sess-min',
      projectPath: PROJECT,
      role: 'reviewer',
      status: 'running',
    });
    expect(row.workItemId).toBeNull();
    expect(row.sdkSessionId).toBeNull();
    expect(row.currentStage).toBeNull();
  });

  it('updateStatus transitions status and captures the sdk session id', () => {
    const { store } = freshStore();
    store.insert({ id: 'sess-2', projectPath: PROJECT, role: 'builder', status: 'running' });

    store.updateStatus('sess-2', 'running', 'sdk-abc-123');
    expect(store.get('sess-2')?.sdkSessionId).toBe('sdk-abc-123');

    // A later status update WITHOUT an sdkSessionId must not wipe the captured one.
    store.updateStatus('sess-2', 'ended');
    const after = store.get('sess-2');
    expect(after?.status).toBe('ended');
    expect(after?.sdkSessionId).toBe('sdk-abc-123');
  });

  it('get returns null for an unknown id', () => {
    const { store } = freshStore();
    expect(store.get('nope')).toBeNull();
  });

  it('rejects an empty required field', () => {
    const { store } = freshStore();
    expect(() => store.insert({ id: '', projectPath: PROJECT, role: 'builder', status: 'running' })).toThrow(
      /session id/,
    );
    expect(() => store.insert({ id: 'x', projectPath: PROJECT, role: '', status: 'running' })).toThrow(
      /role/,
    );
  });
});

describe('additive migration (sessions.role)', () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const path of dbPaths.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    }
  });

  it('adds role to a pre-existing DB that lacks it, and is idempotent on re-open', () => {
    const dbPath = join(tmpdir(), `devos-migration-${randomUUID()}.db`);
    dbPaths.push(dbPath);

    // Simulate an OLD on-disk dev DB: a sessions table WITHOUT the role column.
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  work_item_id TEXT,
  sdk_session_id TEXT,
  status TEXT,
  current_stage TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO sessions(id, project_path, status, created_at) VALUES('legacy', '/p', 'ended', 1);`);
    const before = (old.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
    expect(before).not.toContain('role');
    old.close();

    // openDatabase applies SCHEMA_SQL (IF NOT EXISTS = no-op here) then the additive migration.
    const db1 = openDatabase(dbPath);
    const cols1 = (db1.raw.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols1).toContain('role');
    // Existing data survives — the migration is additive, never destructive.
    const legacy = db1.raw.prepare('SELECT id, role FROM sessions WHERE id = ?').get('legacy') as
      | { id: string; role: string | null }
      | undefined;
    expect(legacy?.id).toBe('legacy');
    expect(legacy?.role).toBeNull();
    db1.close();

    // Re-open the already-migrated DB: the migration must be a no-op, never throw.
    expect(() => {
      const db2 = openDatabase(dbPath);
      db2.close();
    }).not.toThrow();
  });
});
