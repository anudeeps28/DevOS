// Server configuration — resolved and validated once at import time.
//
// Security invariant (ARCHITECTURE §6): the server binds loopback ONLY. HOST is
// hard-pinned to 127.0.0.1 / localhost / ::1 and the process refuses to start if
// asked to bind anything else (e.g. 0.0.0.0). This is validated at the boundary.

import { homedir } from 'node:os';
import { join } from 'node:path';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Enforce the loopback-only invariant (ARCHITECTURE §6). Throws if `host` is not
 * a loopback address. Exported so it can be re-asserted at the `listen()` boundary
 * (defense-in-depth) — not only at config resolution, in case a caller ever passes
 * an explicit host.
 */
export function assertLoopbackHost(host: string): string {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to start: HOST="${host}" is not a loopback address. ` +
        `DevOS binds loopback only (127.0.0.1 / localhost / ::1) — see ARCHITECTURE §6. ` +
        `Unset HOST or set it to 127.0.0.1.`,
    );
  }
  return host;
}

function resolveHost(): string {
  return assertLoopbackHost(process.env.HOST ?? '127.0.0.1');
}

function resolvePort(): number {
  const raw = process.env.PORT ?? '8787';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT="${raw}" — must be an integer between 0 and 65535.`);
  }
  return port;
}

export const HOST: string = resolveHost();
export const PORT: number = resolvePort();

/**
 * Resolve the SQLite database file path. An explicit non-empty `DEVOS_DB_PATH`
 * env var always wins; otherwise fall back to the OS app-data directory joined
 * with `DevOS/devos.db`:
 *   - macOS   → ~/Library/Application Support
 *   - Windows → %APPDATA% (falls back to the home dir if unset)
 *   - Linux/other → $XDG_DATA_HOME || ~/.local/share
 */
export function resolveDbPath(): string {
  const explicit = process.env.DEVOS_DB_PATH;
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const appDataDir = resolveAppDataDir();
  return join(appDataDir, 'DevOS', 'devos.db');
}

function resolveAppDataDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData !== undefined && appData.length > 0 ? appData : homedir();
  }
  const xdgDataHome = process.env.XDG_DATA_HOME;
  return xdgDataHome !== undefined && xdgDataHome.length > 0
    ? xdgDataHome
    : join(homedir(), '.local', 'share');
}

export const DB_PATH: string = resolveDbPath();

/**
 * Resolve the project-root directories to scan for projects. An explicit
 * non-empty `DEVOS_PROJECT_ROOTS` env var always wins: it is split on ':',
 * each segment is trimmed, and empty/whitespace-only segments are dropped.
 * When the var is unset/empty (or every segment is blank), fall back to a
 * single default root: `~/Programming`.
 *
 * The paths are NOT validated for on-disk existence here — that is the
 * scanner's job. Returns a frozen (immutable) array.
 */
export function resolveProjectRoots(): readonly string[] {
  const explicit = process.env.DEVOS_PROJECT_ROOTS;
  if (explicit !== undefined && explicit.length > 0) {
    const roots = explicit
      .split(':')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (roots.length > 0) {
      return Object.freeze(roots);
    }
  }

  return Object.freeze([join(homedir(), 'Programming')]);
}

export const PROJECT_ROOTS: readonly string[] = resolveProjectRoots();

// Heartbeat cadence (ms) — pinned WS contract shared with the web client.
export const HEARTBEAT_INTERVAL_MS = 1000;

// WebSocket upgrade path — identical in dev (Vite proxies it) and prod.
export const WS_PATH = '/ws';

// In prod the Node process also serves the built web/dist over HTTP; in dev,
// Vite serves the app and this server handles /ws only.
export const PROD: boolean = process.env.NODE_ENV === 'production';
