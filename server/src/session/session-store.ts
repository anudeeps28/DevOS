// Session Store — the SINGLE reader/writer of the `sessions` table.
//
// Mirrors registry.ts: a thin, prepared-statement wrapper over one table. Unlike
// the thin-anchor `projects` table, `sessions` holds session HISTORY + the
// work_item_id ↔ session link (many sessions per work item). Live session state
// (running/idle/blocked) is NOT authoritative here — it lives in the in-memory
// SessionManager; this table persists the durable anchor for each session (id,
// project, role, last-known status, sdk session id) for continuity across restarts.
//
// All SQL is prepared and parameterized — never string-concatenated.

import type { DatabaseHandle } from '../db/database.js';

/** A persisted session row (camelCase mirror of the `sessions` table columns). */
export interface SessionRow {
  readonly id: string;
  readonly projectPath: string;
  readonly workItemId: string | null;
  readonly sdkSessionId: string | null;
  readonly role: string | null;
  readonly status: string | null;
  readonly currentStage: string | null;
  readonly createdAt: number;
}

/** Fields accepted when inserting a new session row. */
export interface InsertSessionInput {
  readonly id: string;
  readonly projectPath: string;
  readonly role: string;
  readonly status: string;
  readonly workItemId?: string;
  readonly sdkSessionId?: string;
  readonly currentStage?: string;
}

/** Public surface of the session store. */
export interface SessionStore {
  readonly insert: (input: InsertSessionInput) => SessionRow;
  readonly updateStatus: (id: string, status: string, sdkSessionId?: string) => void;
  readonly list: () => SessionRow[];
  readonly get: (id: string) => SessionRow | null;
  readonly listByWorkItem: (workItemId: string, projectPath: string) => SessionRow[];
}

/** Raw shape of a `sessions` row as returned by better-sqlite3. */
interface SessionDbRow {
  readonly id: string;
  readonly project_path: string;
  readonly work_item_id: string | null;
  readonly sdk_session_id: string | null;
  readonly role: string | null;
  readonly status: string | null;
  readonly current_stage: string | null;
  readonly created_at: number;
}

const COLUMNS =
  'id, project_path, work_item_id, sdk_session_id, role, status, current_stage, created_at';

const SQL_INSERT = `INSERT INTO sessions(${COLUMNS})
VALUES(@id, @project_path, @work_item_id, @sdk_session_id, @role, @status, @current_stage, @created_at)`;

const SQL_SELECT_ALL = `SELECT ${COLUMNS} FROM sessions ORDER BY created_at ASC, id ASC`;

const SQL_SELECT_ONE = `SELECT ${COLUMNS} FROM sessions WHERE id = ?`;

const SQL_SELECT_BY_WORK_ITEM = `SELECT ${COLUMNS} FROM sessions WHERE work_item_id = ? AND project_path = ? ORDER BY created_at ASC, id ASC`;

// Update the last-known status and, when supplied, the sdk_session_id captured
// from the stream's `system/init`. COALESCE keeps the existing sdk_session_id
// when the caller passes none, so a plain status update never wipes it.
const SQL_UPDATE_STATUS =
  'UPDATE sessions SET status = ?, sdk_session_id = COALESCE(?, sdk_session_id) WHERE id = ?';

/** Map a raw DB row into a frozen, immutable SessionRow. */
function toRow(row: SessionDbRow): SessionRow {
  return Object.freeze<SessionRow>({
    id: row.id,
    projectPath: row.project_path,
    workItemId: row.work_item_id,
    sdkSessionId: row.sdk_session_id,
    role: row.role,
    status: row.status,
    currentStage: row.current_stage,
    createdAt: row.created_at,
  });
}

function assertNonEmpty(value: string, field: string, op: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SessionStore.${op}: a non-empty ${field} is required.`);
  }
}

/**
 * Create a SessionStore bound to an open database handle. The returned object is
 * the only component permitted to read or write the `sessions` table.
 */
export function createSessionStore(db: DatabaseHandle): SessionStore {
  const insertStmt = db.raw.prepare(SQL_INSERT);
  const selectAllStmt = db.raw.prepare(SQL_SELECT_ALL);
  const selectOneStmt = db.raw.prepare(SQL_SELECT_ONE);
  const selectByWorkItemStmt = db.raw.prepare(SQL_SELECT_BY_WORK_ITEM);
  const updateStatusStmt = db.raw.prepare(SQL_UPDATE_STATUS);

  const readOne = (id: string): SessionRow | null => {
    const row = selectOneStmt.get(id) as SessionDbRow | undefined;
    return row === undefined ? null : toRow(row);
  };

  const insert = (input: InsertSessionInput): SessionRow => {
    assertNonEmpty(input.id, 'session id', 'insert');
    assertNonEmpty(input.projectPath, 'project path', 'insert');
    assertNonEmpty(input.role, 'role', 'insert');
    assertNonEmpty(input.status, 'status', 'insert');
    try {
      insertStmt.run({
        id: input.id,
        project_path: input.projectPath,
        work_item_id: input.workItemId ?? null,
        sdk_session_id: input.sdkSessionId ?? null,
        role: input.role,
        status: input.status,
        current_stage: input.currentStage ?? null,
        created_at: Date.now(),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`SessionStore.insert: failed to insert session "${input.id}": ${cause}`);
    }
    const row = readOne(input.id);
    if (row === null) {
      throw new Error(`SessionStore.insert: session "${input.id}" not found after insert.`);
    }
    return row;
  };

  const updateStatus = (id: string, status: string, sdkSessionId?: string): void => {
    assertNonEmpty(id, 'session id', 'updateStatus');
    assertNonEmpty(status, 'status', 'updateStatus');
    try {
      updateStatusStmt.run(status, sdkSessionId ?? null, id);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`SessionStore.updateStatus: failed to update session "${id}": ${cause}`);
    }
  };

  const list = (): SessionRow[] => {
    try {
      const rows = selectAllStmt.all() as SessionDbRow[];
      return rows.map(toRow);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`SessionStore.list: failed to read sessions: ${cause}`);
    }
  };

  const get = (id: string): SessionRow | null => {
    assertNonEmpty(id, 'session id', 'get');
    return readOne(id);
  };

  const listByWorkItem = (workItemId: string, projectPath: string): SessionRow[] => {
    assertNonEmpty(workItemId, 'work item id', 'listByWorkItem');
    assertNonEmpty(projectPath, 'project path', 'listByWorkItem');
    try {
      const rows = selectByWorkItemStmt.all(workItemId, projectPath) as SessionDbRow[];
      return rows.map(toRow);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `SessionStore.listByWorkItem: failed to read sessions for work item "${workItemId}": ${cause}`,
      );
    }
  };

  return Object.freeze<SessionStore>({ insert, updateStatus, list, get, listByWorkItem });
}
