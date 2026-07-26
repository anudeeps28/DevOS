// WebSocket gateway — the sole browser<->server *data* transport.
//
// Attaches a `ws` WebSocketServer to the shared http.Server on WS_PATH. Each
// connected client gets its own heartbeat pump; sends are guarded against
// non-OPEN sockets. The upgrade is gated by an Origin allowlist (both modes) and,
// in prod, a local token carried on the Sec-WebSocket-Protocol subprotocol.

import type { IncomingMessage, Server } from 'node:http';
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { HEARTBEAT_INTERVAL_MS, WS_PATH } from './config.js';
import { scanCandidates } from './discovery/scanner.js';
import { readGitState } from './git/git-state-reader.js';
import { createHeartbeat, type HeartbeatMessage } from './heartbeat.js';
import { readLifecycleSignals } from './lifecycle/lifecycle-reader.js';
import type { Registry } from './registry/registry.js';
import { isValidRole } from './session/roles.js';
import type { SessionManager } from './session/session-manager.js';
import { readTrackerState } from './tracker/tracker-reader.js';
import {
  buildAllowedOrigins,
  extractSubprotocolToken,
  isOriginAllowed,
  SUBPROTOCOL,
  tokensMatch,
} from './ws-auth.js';
import {
  MAX_WS_PAYLOAD_BYTES,
  parseInboundMessage,
  type OutboundMessage,
} from './ws-protocol.js';

/** Every frame the gateway is allowed to push over the wire. */
type ServerFrame = HeartbeatMessage | OutboundMessage;

// Minimum interval between two `discover` scans on the SAME socket. Discovery is
// filesystem I/O and the client auto-discovers on every (re)connect, so a flapping
// connection or a spammed frame would otherwise re-scan repeatedly. Repeats inside
// this window are dropped (the client already has, or is about to get, a snapshot).
const DISCOVER_MIN_INTERVAL_MS = 500;

// Minimum interval between two `git-state` reads on the SAME socket. This is a
// FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readGitState` read — git state is never memoized server-side. The window only
// drops rapid-fire repeats on a single socket.
const GIT_STATE_MIN_INTERVAL_MS = 200;

// Minimum interval between two `tracker-state` reads on the SAME socket. This is a
// FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readTrackerState` read — tracker state is never memoized server-side. The window
// only drops rapid-fire repeats on a single socket.
const TRACKER_STATE_MIN_INTERVAL_MS = 200;

// Minimum interval between two `lifecycle-signals` reads on the SAME socket. This is
// a FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readLifecycleSignals` read — never memoized server-side (ARCHITECTURE §9.2: derived
// live per render). The window only drops rapid-fire repeats on a single socket.
const LIFECYCLE_SIGNALS_MIN_INTERVAL_MS = 200;

// Upper bound on the number of distinct paths a single socket's per-PATH
// flood-guard Map may retain. Without this a malicious client could request an
// unbounded number of distinct (pinned) paths and grow the Map without limit.
export const FLOOD_GUARD_MAX_KEYS = 256;

/**
 * Bound a per-socket, per-PATH flood-guard Map before inserting a new key. When
 * the Map is at/over the cap, first drop every entry already older than the
 * flood-guard window (expired — they can never suppress a future request), then,
 * if still at/over the cap, evict oldest-inserted entries (Map iterates in
 * insertion order) until under it. Pure (mutates only the passed Map) and
 * exported for unit testing.
 */
export function pruneFloodGuard(map: Map<string, number>, now: number, windowMs: number): void {
  if (map.size < FLOOD_GUARD_MAX_KEYS) return;

  for (const [path, at] of map) {
    if (now - at >= windowMs) {
      map.delete(path);
    }
  }

  while (map.size >= FLOOD_GUARD_MAX_KEYS) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/** Resolve a path through symlinks; null when it doesn't exist or can't be resolved. */
async function resolveReal(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * True when `candidate` resolves (through symlinks) to a directory INSIDE one of the
 * configured project roots. Spawning a session launches a `claude` subprocess (bash +
 * file tools) with cwd = candidate; pinning alone does NOT bound the cwd (pin accepts
 * any absolute path), so this containment is the actual guard against launching an
 * agent in an arbitrary host directory (e.g. `~/.ssh`). Fails CLOSED: a candidate or
 * root that can't be realpath'd (missing dir, symlink error) never grants access, and
 * empty roots deny everything. Realpath on BOTH sides defeats symlink-escape pins.
 */
async function isWithinProjectRoots(
  candidate: string,
  roots: readonly string[],
): Promise<boolean> {
  const real = await resolveReal(candidate);
  if (real === null) return false;
  for (const root of roots) {
    const realRoot = await resolveReal(root);
    if (realRoot === null) continue;
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (real === realRoot || real.startsWith(prefix)) return true;
  }
  return false;
}

export interface WsGatewayOptions {
  readonly intervalMs?: number;
  readonly registry: Registry;
  readonly sessionManager: SessionManager;
  readonly projectRoots: readonly string[];
  readonly authToken: string;
  readonly requireToken: boolean;
  readonly allowedOrigins?: readonly string[];
}

export interface WsGateway {
  readonly wss: WebSocketServer;
  readonly close: () => Promise<void>;
}

function sendFrame(socket: WebSocket, message: ServerFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return; // guard: never send on a closing/closed socket
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    console.error('[ws] failed to send frame', err);
  }
}

export function attachWsGateway(server: Server, options: WsGatewayOptions): WsGateway {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const { registry } = options;

  // `ws` handles the HTTP upgrade itself, filtered to WS_PATH. maxPayload caps the
  // per-frame size (ws defaults to 100 MiB) so a client can't push huge blobs.
  // The connection gate rejects foreign origins (both modes) and, in prod, any
  // handshake missing/mismatching the local token carried on the subprotocol.
  const wss = new WebSocketServer({
    server,
    path: WS_PATH,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false,
    verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
      const allowed = buildAllowedOrigins(server, !options.requireToken, options.allowedOrigins);
      if (!isOriginAllowed(info.origin, allowed, options.requireToken)) {
        console.warn('[ws] rejected upgrade — origin', info.origin);
        return false;
      }
      if (options.requireToken) {
        const token = extractSubprotocolToken(info.req.headers['sec-websocket-protocol']);
        if (!tokensMatch(token, options.authToken)) {
          console.warn('[ws] rejected upgrade — token');
          return false;
        }
      }
      return true;
    },
  });

  // Build a fresh registry snapshot and push it to every OPEN client so multiple
  // browser tabs stay in sync after any mutation. Reading the registry is guarded
  // — a read failure must never crash the gateway.
  const broadcastRegistry = (): void => {
    let snapshot: OutboundMessage;
    try {
      snapshot = { type: 'registry', projects: registry.listProjects() };
    } catch (err) {
      console.error('[ws] failed to read registry for broadcast', err);
      return;
    }
    for (const client of wss.clients) {
      sendFrame(client, snapshot);
    }
  };

  // Push every owned-session state change to all OPEN clients so the Fleet/card
  // views stay in sync across tabs (mirrors broadcastRegistry). The manager emits
  // from detached stream-consume loops, AFTER the spawn call has returned.
  options.sessionManager.onState((session) => {
    const frame: OutboundMessage = { type: 'session-state', path: session.projectPath, session };
    for (const client of wss.clients) {
      sendFrame(client, frame);
    }
  });

  // Access control (A01): the per-path read frames (git-state, tracker-state,
  // lifecycle-signals) drive FS + git + adapter subprocesses at a client-supplied
  // path. Restrict every read to a currently PINNED project so a client cannot probe
  // arbitrary host directories (a file-existence oracle + subprocess spawning). A read
  // failure while checking the registry fails CLOSED (deny). This is the per-request
  // path-ownership control; the WS Origin/token CONNECTION gate is tracked separately
  // (6h6hMMj3PX4Gjcr8).
  const isPinnedPath = (path: string): boolean => {
    try {
      return registry.listProjects().some((project) => project.path === path);
    } catch (err) {
      console.error('[ws] registry read failed during path-allowlist check', err);
      return false;
    }
  };

  wss.on('connection', (socket: WebSocket) => {
    console.log('[ws] client connected');

    // Per-socket throttle for `discover` — see DISCOVER_MIN_INTERVAL_MS.
    let lastDiscoverAt = 0;

    // Per-socket, per-PATH flood-guard for `git-state` — see
    // GIT_STATE_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // client fans out one request per pinned project in a burst: a per-socket
    // scalar would drop every project after the first. This only drops rapid
    // repeats of the SAME path on the same socket.
    const lastGitStateAt = new Map<string, number>();

    // Per-socket, per-PATH flood-guard for `tracker-state` — see
    // TRACKER_STATE_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // client fans out one request per pinned project in a burst: a per-socket
    // scalar would drop every project after the first. This only drops rapid
    // repeats of the SAME path on the same socket.
    const lastTrackerStateAt = new Map<string, number>();

    // Per-socket, per-PATH flood-guard for `lifecycle-signals` — see
    // LIFECYCLE_SIGNALS_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // single socket fans out one read per pinned project; a per-socket scalar would
    // drop the fan-out.
    const lastLifecycleSignalsAt = new Map<string, number>();

    const heartbeat = createHeartbeat({
      intervalMs,
      emit: (message) => sendFrame(socket, message),
    });
    heartbeat.start();

    // Send an initial snapshot so a freshly-connected client renders current
    // state without waiting for a mutation.
    try {
      sendFrame(socket, { type: 'registry', projects: registry.listProjects() });
    } catch (err) {
      console.error('[ws] failed to send initial registry snapshot', err);
    }

    socket.on('message', async (data) => {
      // Boundary: validate every inbound frame; malformed input is dropped, never thrown.
      const message = parseInboundMessage(data.toString());
      if (message === null) {
        console.warn('[ws] dropped malformed inbound frame');
        return;
      }

      // Discovery scan: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a scan/read failure never crashes the gateway.
      if (message.type === 'discover') {
        // Throttle: drop repeats within the min-interval on this socket.
        const now = Date.now();
        if (now - lastDiscoverAt < DISCOVER_MIN_INTERVAL_MS) return;
        lastDiscoverAt = now;

        try {
          const pinnedPaths = new Set(registry.listProjects().map((p) => p.path));
          const candidates = await scanCandidates(options.projectRoots, pinnedPaths);
          sendFrame(socket, { type: 'candidates', candidates });
        } catch (err) {
          console.error('[ws] discovery scan failed', err);
          // Send an empty snapshot so the client isn't left hanging.
          sendFrame(socket, { type: 'candidates', candidates: [] });
        }
        return;
      }

      // Git-state read: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'git-state') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastGitStateAt.get(message.path) ?? 0;
        if (now - last < GIT_STATE_MIN_INTERVAL_MS) return;
        pruneFloodGuard(lastGitStateAt, now, GIT_STATE_MIN_INTERVAL_MS);
        lastGitStateAt.set(message.path, now);

        try {
          const state = await readGitState(message.path);
          sendFrame(socket, { type: 'git-state', path: message.path, state });
        } catch (err) {
          console.error('[ws] git-state read failed', err);
        }
        return;
      }

      // Tracker-state read: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'tracker-state') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastTrackerStateAt.get(message.path) ?? 0;
        if (now - last < TRACKER_STATE_MIN_INTERVAL_MS) return;
        pruneFloodGuard(lastTrackerStateAt, now, TRACKER_STATE_MIN_INTERVAL_MS);
        lastTrackerStateAt.set(message.path, now);

        try {
          const state = await readTrackerState(message.path);
          sendFrame(socket, { type: 'tracker-state', path: message.path, state });
        } catch (err) {
          console.error('[ws] tracker-state read failed', err);
        }
        return;
      }

      if (message.type === 'lifecycle-signals') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastLifecycleSignalsAt.get(message.path) ?? 0;
        if (now - last < LIFECYCLE_SIGNALS_MIN_INTERVAL_MS) return;
        pruneFloodGuard(lastLifecycleSignalsAt, now, LIFECYCLE_SIGNALS_MIN_INTERVAL_MS);
        lastLifecycleSignalsAt.set(message.path, now);

        try {
          const signals = await readLifecycleSignals(message.path);
          sendFrame(socket, {
            type: 'lifecycle-signals',
            path: message.path,
            state: { path: message.path, signals },
          });
        } catch (err) {
          console.error('[ws] lifecycle-signals read failed', err);
        }
        return;
      }

      // Session spawn: start an owned Agent-SDK session for a pinned project + role.
      // No per-path flood-guard here (unlike the auto-firing read frames): spawns are
      // deliberate actions and a project may legitimately run several concurrent
      // sessions. The global session-spawn-limit semaphore (concurrency cap + bounded
      // queue) is the DoS bound. `session-state` frames are pushed via onState above.
      if (message.type === 'session-spawn') {
        // Access control (layer 1): only spawn for pinned projects (fails closed).
        if (!isPinnedPath(message.path)) return;
        // Defense-in-depth: re-validate the role (parseInboundMessage already did) to
        // narrow the string to the Role union before handing it to the manager.
        if (!isValidRole(message.role)) return;
        // Access control (layer 2): the spawn cwd runs a `claude` subprocess with bash +
        // file tools, so it MUST resolve within a configured PROJECT_ROOT — pinning alone
        // doesn't bound the cwd (pin takes any absolute path). Fails closed on any path
        // that can't be contained. (Realpath is async → awaited here.)
        if (!(await isWithinProjectRoots(message.path, options.projectRoots))) {
          console.warn('[ws] rejected session-spawn — path outside project roots');
          return;
        }
        try {
          await options.sessionManager.spawn({
            projectPath: message.path,
            role: message.role,
            ...(message.workItemId !== undefined ? { workItemId: message.workItemId } : {}),
          });
        } catch (err) {
          // A spawn failure (e.g. queue full) must never crash the gateway.
          console.error('[ws] session-spawn failed', err);
        }
        return;
      }

      try {
        if (message.type === 'pin') {
          registry.pin(message.path, {
            // Conditional spreads keep optional fields absent (never `undefined`)
            // so the call satisfies exactOptionalPropertyTypes.
            ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
            ...('uiPrefs' in message ? { uiPrefs: message.uiPrefs } : {}),
          });
        } else {
          registry.unpin(message.path);
        }
        broadcastRegistry();
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        console.error(`[ws] registry ${message.type} failed`, err);
        sendFrame(socket, {
          type: 'registry:error',
          op: message.type,
          path: message.path,
          message: errMessage,
        });
      }
    });

    socket.on('close', () => {
      console.log('[ws] client disconnected');
      heartbeat.stop();
    });

    socket.on('error', (err) => {
      console.error('[ws] client socket error', err);
      heartbeat.stop();
    });
  });

  wss.on('error', (err) => {
    console.error('[ws] server error', err);
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch (err) {
          console.error('[ws] error terminating client', err);
        }
      }
      wss.close(() => resolve());
    });

  return { wss, close };
}
