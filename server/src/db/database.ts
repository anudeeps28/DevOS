// SQLite database module — opens (or creates) the DevOS DB, enables WAL +
// foreign keys, and applies the schema. Returns a small typed handle wrapping
// the raw better-sqlite3 instance so callers never import the driver directly.
//
// better-sqlite3 is a CJS module (`export =`); with esModuleInterop on it is
// imported as a default import. `Database.Database` is the instance type.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { SCHEMA_SQL } from './schema.js';

// Sentinel path for an in-memory database — no parent directory to create.
const IN_MEMORY_PATH = ':memory:';

/**
 * Typed handle around a better-sqlite3 instance. `raw` exposes the underlying
 * driver for query modules; `close()` releases the connection.
 */
export interface DatabaseHandle {
  readonly raw: Database.Database;
  readonly close: () => void;
}

function ensureParentDir(dbPath: string): void {
  if (dbPath === IN_MEMORY_PATH) return;
  const dir = dirname(dbPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to create database directory "${dir}" for DB path "${dbPath}": ${cause}`,
    );
  }
}

/**
 * Open (creating if needed) the DevOS SQLite database at `dbPath`, enable WAL
 * journaling and foreign-key enforcement, and apply the schema. Pass
 * `':memory:'` for an ephemeral in-memory DB (used by tests).
 *
 * Throws a wrapped error — including `dbPath` — on any failure.
 */
export function openDatabase(dbPath: string): DatabaseHandle {
  if (dbPath.length === 0) {
    throw new Error('openDatabase requires a non-empty dbPath.');
  }

  ensureParentDir(dbPath);

  let raw: Database.Database;
  try {
    raw = new Database(dbPath);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.exec(SCHEMA_SQL);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to open SQLite database at "${dbPath}": ${cause}`);
  }

  const close = (): void => {
    try {
      raw.close();
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to close SQLite database at "${dbPath}": ${cause}`);
    }
  };

  return Object.freeze({ raw, close });
}
