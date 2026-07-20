// Project Registry — the SINGLE reader/writer of the `projects` table.
//
// THIN-ANCHOR INVARIANT (AC2, SPEC §4): this API deliberately has NO setter for
// git state, tracker tasks, live session state, or lifecycle stage — those are
// live-derived at read time and are NEVER persisted here. Do NOT add persistence
// for any derived field; the registry stores only anchors that cannot be
// recomputed: { path, displayName, pinned, uiPrefs, createdAt }.
//
// All SQL is prepared and parameterized — never string-concatenated.

import type { DatabaseHandle } from '../db/database.js';
import type { ProjectAnchor } from '../ws-protocol.js';

/** Options accepted when pinning (creating/updating) an anchor. */
export interface PinOptions {
  readonly displayName?: string;
  readonly uiPrefs?: unknown;
}

/** Public surface of the registry — anchors ONLY. */
export interface Registry {
  readonly listProjects: () => ProjectAnchor[];
  readonly pin: (path: string, opts?: PinOptions) => ProjectAnchor;
  readonly unpin: (path: string) => void;
  readonly setPrefs: (path: string, uiPrefs: unknown) => void;
}

/** Raw shape of a `projects` row as returned by better-sqlite3. */
interface ProjectRow {
  readonly path: string;
  readonly display_name: string | null;
  readonly pinned: number;
  readonly ui_prefs_json: string | null;
  readonly created_at: number;
}

const SQL_SELECT_ALL =
  'SELECT path, display_name, pinned, ui_prefs_json, created_at FROM projects ORDER BY created_at ASC, path ASC';

const SQL_SELECT_ONE =
  'SELECT path, display_name, pinned, ui_prefs_json, created_at FROM projects WHERE path = ?';

// On re-pin, COALESCE preserves previously-stored anchor metadata when the new
// pin omits it: a bare pin(path) (displayName/uiPrefs NULL) must NOT wipe a name
// or prefs set earlier. To explicitly change prefs, use setPrefs (a direct UPDATE
// that can also clear them). This keeps the anchor store durable — its whole job.
const SQL_UPSERT = `INSERT INTO projects(path, display_name, pinned, ui_prefs_json, created_at)
VALUES(?, ?, 1, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  pinned = 1,
  display_name = COALESCE(excluded.display_name, projects.display_name),
  ui_prefs_json = COALESCE(excluded.ui_prefs_json, projects.ui_prefs_json)`;

const SQL_DELETE = 'DELETE FROM projects WHERE path = ?';

const SQL_UPDATE_PREFS = 'UPDATE projects SET ui_prefs_json = ? WHERE path = ?';

/**
 * Decode a `ui_prefs_json` column into the `uiPrefs` anchor field.
 * A NULL column maps to `null`; otherwise the stored JSON is parsed.
 */
function decodeUiPrefs(raw: string | null, path: string): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Registry: stored ui_prefs_json for project "${path}" is not valid JSON: ${cause}`,
    );
  }
}

/**
 * Serialize a `uiPrefs` value for storage. `undefined` becomes a NULL column;
 * anything else is JSON-stringified.
 */
function encodeUiPrefs(uiPrefs: unknown, path: string): string | null {
  if (uiPrefs === undefined) return null;
  try {
    return JSON.stringify(uiPrefs);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Registry: failed to serialize uiPrefs for project "${path}" to JSON: ${cause}`,
    );
  }
}

/** Map a raw DB row into a frozen, immutable ProjectAnchor. */
function toAnchor(row: ProjectRow): ProjectAnchor {
  return Object.freeze<ProjectAnchor>({
    path: row.path,
    displayName: row.display_name,
    pinned: row.pinned !== 0,
    uiPrefs: decodeUiPrefs(row.ui_prefs_json, row.path),
    createdAt: row.created_at,
  });
}

function assertNonEmptyPath(path: string, op: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`Registry.${op}: a non-empty project path is required.`);
  }
}

/**
 * Create a Registry bound to an open database handle. The returned object is the
 * only component permitted to read or write the `projects` table.
 */
export function createRegistry(db: DatabaseHandle): Registry {
  const selectAllStmt = db.raw.prepare(SQL_SELECT_ALL);
  const selectOneStmt = db.raw.prepare(SQL_SELECT_ONE);
  const upsertStmt = db.raw.prepare(SQL_UPSERT);
  const deleteStmt = db.raw.prepare(SQL_DELETE);
  const updatePrefsStmt = db.raw.prepare(SQL_UPDATE_PREFS);

  const readOne = (path: string, op: string): ProjectAnchor => {
    const row = selectOneStmt.get(path) as ProjectRow | undefined;
    if (row === undefined) {
      throw new Error(`Registry.${op}: no project anchor found for path "${path}".`);
    }
    return toAnchor(row);
  };

  const listProjects = (): ProjectAnchor[] => {
    try {
      const rows = selectAllStmt.all() as ProjectRow[];
      return rows.map(toAnchor);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Registry.listProjects: failed to read project anchors: ${cause}`);
    }
  };

  const pin = (path: string, opts?: PinOptions): ProjectAnchor => {
    assertNonEmptyPath(path, 'pin');
    const displayName = opts?.displayName ?? null;
    const uiPrefsJson = encodeUiPrefs(opts?.uiPrefs, path);
    const createdAt = Date.now();
    try {
      // created_at is only applied on first insert; the ON CONFLICT UPDATE branch
      // deliberately omits it, preserving the original creation time.
      upsertStmt.run(path, displayName, uiPrefsJson, createdAt);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Registry.pin: failed to pin project "${path}": ${cause}`);
    }
    return readOne(path, 'pin');
  };

  const unpin = (path: string): void => {
    assertNonEmptyPath(path, 'unpin');
    try {
      // Untrack = remove the anchor entirely ("nothing tracked without opt-in").
      deleteStmt.run(path);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Registry.unpin: failed to unpin project "${path}": ${cause}`);
    }
  };

  const setPrefs = (path: string, uiPrefs: unknown): void => {
    assertNonEmptyPath(path, 'setPrefs');
    const uiPrefsJson = encodeUiPrefs(uiPrefs, path);
    try {
      updatePrefsStmt.run(uiPrefsJson, path);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`Registry.setPrefs: failed to set uiPrefs for project "${path}": ${cause}`);
    }
  };

  return Object.freeze<Registry>({ listProjects, pin, unpin, setPrefs });
}
