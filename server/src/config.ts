// Server configuration — resolved and validated once at import time.
//
// Security invariant (ARCHITECTURE §6): the server binds loopback ONLY. HOST is
// hard-pinned to 127.0.0.1 / localhost / ::1 and the process refuses to start if
// asked to bind anything else (e.g. 0.0.0.0). This is validated at the boundary.

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

// Heartbeat cadence (ms) — pinned WS contract shared with the web client.
export const HEARTBEAT_INTERVAL_MS = 1000;

// WebSocket upgrade path — identical in dev (Vite proxies it) and prod.
export const WS_PATH = '/ws';

// In prod the Node process also serves the built web/dist over HTTP; in dev,
// Vite serves the app and this server handles /ws only.
export const PROD: boolean = process.env.NODE_ENV === 'production';
