// SQLite schema for DevOS — a single SQL string executed at DB open time.
//
// THIN-ANCHOR INVARIANT (ARCHITECTURE): the `projects` table persists ONLY
// anchors — { path, pinned, displayName, uiPrefs }. Git status, tracker state,
// live session data, and the current lifecycle stage are ALWAYS live-derived at
// read time and are NEVER stored here. Persisting derived state would let it
// drift from reality; the DB holds only what cannot be recomputed.
//
// This lives in a .ts string (not a .sql file) on purpose: tsc does not copy
// non-.ts assets into dist/, and prod/e2e run from the compiled dist/ output.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  path TEXT PRIMARY KEY,
  display_name TEXT,
  pinned INTEGER NOT NULL DEFAULT 1,
  ui_prefs_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL REFERENCES projects(path),
  work_item_id TEXT,
  sdk_session_id TEXT,
  role TEXT,
  status TEXT,
  current_stage TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
`;
