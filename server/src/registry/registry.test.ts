// Unit tests for the project Registry — the single reader/writer of the
// `projects` anchor table. Each test runs against a fresh in-memory DB.
//
// The AC2 guard here mirrors the schema-level AC2 test in database.test.ts:
// the registry's public surface must expose ONLY the four anchor operations
// {listProjects, pin, unpin, setPrefs} — NO setter whose name references a
// derived field (setGitState / setStage / setTracker / setSession / etc.),
// because derived state is live-computed at read time and never persisted.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../db/database.js';
import { createRegistry, type Registry } from './registry.js';

const TEST_PATH = '/abs/p';

let db: DatabaseHandle;
let registry: Registry;

beforeEach(() => {
  db = openDatabase(':memory:');
  registry = createRegistry(db);
});

afterEach(() => {
  db.close();
});

describe('Registry.pin', () => {
  it('creates a pinned row with displayName and uiPrefs intact', () => {
    registry.pin(TEST_PATH, { displayName: 'X', uiPrefs: { a: 1 } });

    const projects = registry.listProjects();
    const anchor = projects.find((p) => p.path === TEST_PATH);

    expect(anchor).toBeDefined();
    expect(anchor).toMatchObject({
      path: TEST_PATH,
      pinned: true,
      displayName: 'X',
      uiPrefs: { a: 1 },
    });
  });

  it('is idempotent: pinning the same path twice yields exactly one row with updated values', () => {
    const first = registry.pin(TEST_PATH, { displayName: 'First', uiPrefs: { a: 1 } });
    const originalCreatedAt = first.createdAt;

    const second = registry.pin(TEST_PATH, { displayName: 'Second', uiPrefs: { b: 2 } });

    const forPath = registry.listProjects().filter((p) => p.path === TEST_PATH);
    expect(forPath).toHaveLength(1);
    expect(forPath[0]).toMatchObject({
      path: TEST_PATH,
      displayName: 'Second',
      uiPrefs: { b: 2 },
    });

    // created_at is applied only on first insert; the ON CONFLICT branch must preserve it.
    expect(second.createdAt).toBe(originalCreatedAt);
    expect(forPath[0]!.createdAt).toBe(originalCreatedAt);
  });

  it('re-pinning without opts preserves previously-stored displayName and uiPrefs', () => {
    // The UI's pin button sends only the path. Re-pinning an already-pinned
    // project must NOT wipe the name/prefs set earlier (anchor durability).
    registry.pin(TEST_PATH, { displayName: 'Kept', uiPrefs: { a: 1 } });

    const after = registry.pin(TEST_PATH);

    expect(after).toMatchObject({
      path: TEST_PATH,
      pinned: true,
      displayName: 'Kept',
      uiPrefs: { a: 1 },
    });
    const forPath = registry.listProjects().filter((p) => p.path === TEST_PATH);
    expect(forPath).toHaveLength(1);
    expect(forPath[0]).toMatchObject({ displayName: 'Kept', uiPrefs: { a: 1 } });
  });

  it('round-trips uiPrefs JSON: an object goes in and an equal object comes out', () => {
    const prefs = { theme: 'dark', columns: [1, 2, 3], nested: { open: true } };
    registry.pin(TEST_PATH, { uiPrefs: prefs });

    const anchor = registry.listProjects().find((p) => p.path === TEST_PATH);
    expect(anchor?.uiPrefs).toEqual(prefs);
  });

  it('without opts: displayName is null and uiPrefs is null', () => {
    registry.pin(TEST_PATH);

    const anchor = registry.listProjects().find((p) => p.path === TEST_PATH);
    expect(anchor?.displayName).toBeNull();
    expect(anchor?.uiPrefs).toBeNull();
  });

  it('returns a frozen anchor', () => {
    const anchor = registry.pin(TEST_PATH, { displayName: 'X' });
    expect(Object.isFrozen(anchor)).toBe(true);
  });
});

describe('Registry.setPrefs', () => {
  it('updates only uiPrefs, leaving displayName unchanged', () => {
    registry.pin(TEST_PATH, { displayName: 'KeepMe', uiPrefs: { a: 1 } });

    registry.setPrefs(TEST_PATH, { b: 2 });

    const anchor = registry.listProjects().find((p) => p.path === TEST_PATH);
    expect(anchor?.uiPrefs).toEqual({ b: 2 });
    expect(anchor?.displayName).toBe('KeepMe');
  });
});

describe('Registry.unpin', () => {
  it('removes the row for the given path', () => {
    registry.pin(TEST_PATH);
    expect(registry.listProjects().some((p) => p.path === TEST_PATH)).toBe(true);

    registry.unpin(TEST_PATH);
    expect(registry.listProjects().some((p) => p.path === TEST_PATH)).toBe(false);
  });
});

describe('Registry — AC2 thin-anchor surface (setter-absence guard)', () => {
  it('exposes EXACTLY {listProjects, pin, unpin, setPrefs} — no derived-field setter', () => {
    const keys = Object.keys(registry).sort();

    // Exact set: any extra key (e.g. setGitState/setStage/setTracker/setSession)
    // or a missing anchor op fails here — the registry must persist anchors only.
    expect(keys).toEqual(['listProjects', 'pin', 'setPrefs', 'unpin']);
  });

  it('the returned registry object is frozen', () => {
    expect(Object.isFrozen(registry)).toBe(true);
  });
});
