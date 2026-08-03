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
import type { HookBus } from './hooks/hook-bus.js';
import { readLifecycleSignals } from './lifecycle/lifecycle-reader.js';
import type { Registry } from './registry/registry.js';
import type { Bridge } from './session/bridge.js';
import type { CostLedgerStore } from './session/cost-ledger-store.js';
import { readSessionPersonas } from './session/persona-reader.js';
import { isValidRole } from './session/roles.js';
import { readRoster } from './session/roster-reader.js';
import { buildRosterTimeline } from './session/roster-timeline.js';
import type { SessionManager } from './session/session-manager.js';
import type { SessionStore } from './session/session-store.js';
import { readSkills } from './skills/skills-reader.js';
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

// Minimum interval between two `skills` reads on the SAME socket. This is a
// FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readSkills` read — skills state is never memoized server-side. The window only
// drops rapid-fire repeats on a single socket.
const SKILLS_MIN_INTERVAL_MS = 200;

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

// Minimum interval between two `session-personas` reads on the SAME socket. This is
// a FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readSessionPersonas` read (roster + phase.md are never memoized server-side). The
// window only drops rapid-fire repeats of the SAME path on a single socket.
const SESSION_PERSONAS_MIN_INTERVAL_MS = 200;

// Minimum interval between two `work-item-sessions-request` reads for the SAME
// (path, workItemId) pair on the SAME socket. This is a FLOOD-GUARD ONLY, never a
// cache: every accepted request always does a fresh `sessionStore.listByWorkItem`
// read. The window only drops rapid-fire repeats of the SAME key on a single socket.
const WORK_ITEM_SESSIONS_MIN_INTERVAL_MS = 200;

// Minimum interval between two `session-transcript-request` backfills for the SAME
// session on the SAME socket. This is a FLOOD-GUARD ONLY, never a cache: every
// accepted request reads the live buffer fresh via `getTranscript`. The window only
// drops rapid-fire repeats of one sessionId on a single socket.
const SESSION_TRANSCRIPT_REQUEST_MIN_INTERVAL_MS = 200;

// Minimum interval between two `roster-timeline` reads on the SAME socket. This is
// a FLOOD-GUARD ONLY, never a cache: every accepted request always does a fresh
// `readRoster` read (the roster is never memoized server-side). The window only
// drops rapid-fire repeats of the SAME path on a single socket.
const ROSTER_TIMELINE_MIN_INTERVAL_MS = 200;

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
  readonly sessionStore: SessionStore;
  readonly bridge: Bridge;
  readonly hookBus: HookBus;
  readonly costLedger: CostLedgerStore;
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

// Deterministic canned fleet fixture for e2e — gated on DEVOS_E2E_FLEET_FIXTURE so it
// NEVER runs unless explicitly opted into. One pinned fixture path ("WI-1"): a running
// builder and a rate-limited reviewer, their persona join, and a sample tool-use event
// for the builder session — enough for the Fleet tab to render without a live SDK.
const FLEET_FIXTURE_PATH = '/tmp/devos-e2e-fleet-fixture';
const FLEET_FIXTURE_WORK_ITEM_ID = 'WI-1';
const FLEET_FIXTURE_BUILDER_SESSION_ID = 'e2e-fixture-builder';
const FLEET_FIXTURE_REVIEWER_SESSION_ID = 'e2e-fixture-reviewer';

/** Send the deterministic canned fleet fixture frames to one freshly-connected client. */
function sendFleetFixture(socket: WebSocket): void {
  const builder: OutboundMessage = {
    type: 'session-state',
    path: FLEET_FIXTURE_PATH,
    session: {
      id: FLEET_FIXTURE_BUILDER_SESSION_ID,
      projectPath: FLEET_FIXTURE_PATH,
      role: 'builder',
      status: 'running',
      sdkSessionId: null,
      workItemId: FLEET_FIXTURE_WORK_ITEM_ID,
      rateLimited: false,
    },
  };
  const reviewer: OutboundMessage = {
    type: 'session-state',
    path: FLEET_FIXTURE_PATH,
    session: {
      id: FLEET_FIXTURE_REVIEWER_SESSION_ID,
      projectPath: FLEET_FIXTURE_PATH,
      role: 'reviewer',
      status: 'running',
      sdkSessionId: null,
      workItemId: FLEET_FIXTURE_WORK_ITEM_ID,
      rateLimited: true,
    },
  };
  const personas: OutboundMessage = {
    type: 'session-personas',
    path: FLEET_FIXTURE_PATH,
    personas: [
      {
        sessionId: FLEET_FIXTURE_BUILDER_SESSION_ID,
        workItemId: FLEET_FIXTURE_WORK_ITEM_ID,
        role: 'builder',
        phase: 'coding',
        persona: 'Shipwright',
      },
      {
        sessionId: FLEET_FIXTURE_REVIEWER_SESSION_ID,
        workItemId: FLEET_FIXTURE_WORK_ITEM_ID,
        role: 'reviewer',
        phase: 'reviewing',
        persona: 'Warden',
      },
    ],
  };
  const transcript: OutboundMessage = {
    type: 'session-transcript',
    path: FLEET_FIXTURE_PATH,
    sessionId: FLEET_FIXTURE_BUILDER_SESSION_ID,
    events: [
      {
        kind: 'tool-use',
        toolName: 'Task',
        toolInput: '{}',
        toolUseId: 'e2e-fixture-tool-use-1',
        sessionId: FLEET_FIXTURE_BUILDER_SESSION_ID,
        seq: 0,
        ts: Date.now(),
      },
    ],
  };
  sendFrame(socket, builder);
  sendFrame(socket, reviewer);
  sendFrame(socket, personas);
  sendFrame(socket, transcript);
}

// Deterministic canned inbox fixture for e2e — gated on DEVOS_E2E_INBOX_FIXTURE so it
// NEVER runs unless explicitly opted into. One pinned fixture path, gate='escalated',
// with a chips-bearing agent-question item and an escalation item — enough for the
// Needs-you inbox to render both the Question and Escalation cards without a live SDK.
const INBOX_FIXTURE_PATH = '/tmp/devos-e2e-inbox-fixture';

/** Send the deterministic canned inbox fixture frame to one freshly-connected client. */
function sendInboxFixture(socket: WebSocket): void {
  const state: OutboundMessage = {
    type: 'bridge-state',
    path: INBOX_FIXTURE_PATH,
    stage: 'builder',
    gate: 'escalated',
    sessionId: null,
    inbox: [
      {
        stage: 'builder',
        kind: 'question',
        reason: 'Which approach should the agent take?',
        chips: ['Option A', 'Option B'],
        ts: Date.now(),
      },
      {
        stage: 'builder',
        kind: 'escalation',
        reason: 'Rework loop-cap hit — needs an operator decision.',
        ts: Date.now(),
      },
    ],
    reworkCount: 0,
  };
  sendFrame(socket, state);
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

  // Push every owned-session state change to all OPEN clients so the Fleet/card
  // views stay in sync across tabs (mirrors broadcastRegistry). The manager emits
  // from detached stream-consume loops, AFTER the spawn call has returned.
  options.sessionManager.onState((session) => {
    const frame: OutboundMessage = { type: 'session-state', path: session.projectPath, session };
    for (const client of wss.clients) {
      sendFrame(client, frame);
    }
  });

  // Push every transcript event batch to all OPEN clients so every tab's Team room
  // stays live (mirrors the onState broadcast above). The manager emits from
  // detached stream-consume loops, AFTER the spawn call has returned.
  // Access control: broadcast ONLY sessions owned by a currently-pinned project —
  // the same isPinnedPath gate the socket-targeted backfill path applies (an
  // unpinned project's transcript must never fan out to clients; fails closed).
  options.sessionManager.onTranscript((path, sessionId, events) => {
    if (!isPinnedPath(path)) return;
    const frame: OutboundMessage = { type: 'session-transcript', path, sessionId, events };
    for (const client of wss.clients) {
      sendFrame(client, frame);
    }
  });

  // Push every permission request raised by a live owned session to all OPEN
  // clients so every tab's Team room can prompt for a decision (mirrors the
  // onTranscript broadcast above). Access control: broadcast ONLY requests owned
  // by a currently-pinned project — the same isPinnedPath gate the other
  // broadcasts apply (fails closed).
  options.sessionManager.onPermissionRequest((path, sessionId, req) => {
    if (!isPinnedPath(path)) return;
    const frame: OutboundMessage = {
      type: 'permission-request',
      path,
      sessionId,
      requestId: req.requestId,
      toolUseId: req.toolUseId,
      toolName: req.toolName,
      title: req.title,
      input: req.input,
    };
    for (const client of wss.clients) {
      sendFrame(client, frame);
    }
  });

  // Push the latest cost/usage aggregate to all OPEN clients whenever the manager
  // records a `result` — mirrors the onState/onTranscript broadcasts above. This
  // figure is account-wide (not project-scoped), so it broadcasts to every client
  // with NO isPinnedPath gate.
  options.sessionManager.onCostUsage((usage) => {
    const frame: OutboundMessage = { type: 'cost-usage', ...usage };
    for (const client of wss.clients) {
      sendFrame(client, frame);
    }
  });

  // Push every Bridge run state change to all OPEN clients so every tab's Bridge
  // view stays in sync (mirrors the onState/onTranscript broadcasts above).
  // Access control: broadcast ONLY runs owned by a currently-pinned project — the
  // same isPinnedPath gate the other broadcasts apply (fails closed).
  options.bridge.onState((snap) => {
    if (!isPinnedPath(snap.path)) return;
    for (const client of wss.clients) {
      sendFrame(client, snap);
    }
  });

  // Push every foreign-session hook event to all OPEN clients so any tab can
  // surface a needs-you signal for a session this server does not own. Access
  // control: broadcast ONLY for a cwd that is BOTH currently pinned AND resolves
  // within a configured project root — a hook payload's cwd is client-controlled
  // (posted over HTTP by a hook forwarder), so this mirrors the two-layer
  // spawn/bridge-start gate above and fails closed on either check.
  options.hookBus.onEvent(async (e) => {
    // A `needs-you` event injects UI state, so it passes the full two-layer
    // gate (pinned AND realpath-within-roots). A `clear` only REMOVES existing
    // UI state and carries no new path exposure, so it is gated on the cheap
    // sync isPinnedPath check alone — skipping the realpath check that would
    // throw (and leak a stuck inbox item) if the session's dir was deleted
    // between its Notification and its SessionEnd.
    if (!isPinnedPath(e.cwd)) {
      console.warn('[ws] dropped foreign hook — cwd not pinned');
      return;
    }
    if (e.kind === 'needs-you' && !(await isWithinProjectRoots(e.cwd, options.projectRoots))) {
      console.warn('[ws] dropped foreign hook — cwd not within roots');
      return;
    }
    const frame: OutboundMessage =
      e.kind === 'needs-you'
        ? {
            type: 'foreign-session-needs-you',
            path: e.cwd,
            sessionId: e.sessionId,
            kind: e.notifKind,
            reason: e.reason,
            ts: e.ts,
            cleared: false,
          }
        : {
            type: 'foreign-session-needs-you',
            path: e.cwd,
            sessionId: e.sessionId,
            kind: 'permission_prompt',
            reason: '',
            ts: e.ts,
            cleared: true,
          };
    for (const client of wss.clients) {
      sendFrame(client, frame);
    }
  });

  // Push every hook-bus liveness flip to all OPEN clients so every tab's
  // connection indicator stays in sync (mirrors the other broadcasts above).
  options.hookBus.onLiveness((connected, lastReceivedAt) => {
    const frame: OutboundMessage = { type: 'hook-bus-liveness', connected, lastReceivedAt };
    for (const client of wss.clients) {
      sendFrame(client, frame);
    }
  });

  // Drive hook-bus staleness sweeps on a single gateway-level interval (not
  // per-socket) — cleared in close().
  const hookStaleInterval = setInterval(() => {
    options.hookBus.checkStale(Date.now());
  }, intervalMs);

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

    // Per-socket, per-PATH flood-guard for `skills` — see
    // SKILLS_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // client fans out one request per pinned project in a burst: a per-socket
    // scalar would drop every project after the first. This only drops rapid
    // repeats of the SAME path on the same socket.
    const lastSkillsAt = new Map<string, number>();

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

    // Per-socket, per-PATH flood-guard for `session-personas` — see
    // SESSION_PERSONAS_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // single socket fans out one read per pinned project; a per-socket scalar would
    // drop the fan-out.
    const lastSessionPersonasAt = new Map<string, number>();

    // Per-socket, per-KEY flood-guard for `work-item-sessions-request` — see
    // WORK_ITEM_SESSIONS_MIN_INTERVAL_MS. Keyed by `path workItemId` (not a
    // single scalar) because a client fans out one request per pinned work item;
    // a per-socket scalar would drop the fan-out.
    const lastWorkItemSessionsAt = new Map<string, number>();

    // Per-socket, per-SESSION flood-guard for `session-transcript-request` — see
    // SESSION_TRANSCRIPT_REQUEST_MIN_INTERVAL_MS. Keyed by sessionId (not a single
    // scalar) because a client backfills once per live session in a burst on
    // (re)connect; a per-socket scalar would drop every session after the first.
    const lastTranscriptRequestAt = new Map<string, number>();

    // Per-socket, per-PATH flood-guard for `roster-timeline` — see
    // ROSTER_TIMELINE_MIN_INTERVAL_MS. Keyed by path (not a single scalar) because a
    // single socket fans out one read per pinned project; a per-socket scalar would
    // drop the fan-out.
    const lastRosterTimelineAt = new Map<string, number>();

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
    sendFrame(socket, { type: 'hook-bus-liveness', ...options.hookBus.getLiveness(Date.now()) });

    try {
      sendFrame(socket, { type: 'cost-usage', ...options.costLedger.costToday() });
    } catch (err) {
      console.error('[ws] failed to send initial cost-usage snapshot', err);
    }

    // e2e fixture: only when explicitly opted into via env — never runs otherwise.
    if (process.env['DEVOS_E2E_FLEET_FIXTURE'] === '1') {
      sendFleetFixture(socket);
    }

    // e2e fixture: only when explicitly opted into via env — never runs otherwise.
    if (process.env['DEVOS_E2E_INBOX_FIXTURE'] === '1') {
      sendInboxFixture(socket);
    }

    // e2e fixture: a single deterministic non-zero cost-usage frame so the e2e can
    // assert the figure updates from the empty-DB snapshot (0.00) to $1.23. Only when
    // explicitly opted into via env — never runs otherwise.
    if (process.env['DEVOS_E2E_COST_FIXTURE'] === '1') {
      sendFrame(socket, {
        type: 'cost-usage',
        costTodayUsd: 1.2345,
        inputTokensToday: 1200,
        outputTokensToday: 3400,
        sinceEpochMs: Date.now(),
      });
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

      // Skills read: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'skills') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastSkillsAt.get(message.path) ?? 0;
        if (now - last < SKILLS_MIN_INTERVAL_MS) return;
        pruneFloodGuard(lastSkillsAt, now, SKILLS_MIN_INTERVAL_MS);
        lastSkillsAt.set(message.path, now);

        try {
          const state = readSkills(message.path);
          sendFrame(socket, { type: 'skills', path: message.path, state });
        } catch (err) {
          console.error('[ws] skills read failed', err);
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

      // Session-personas read: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'session-personas') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastSessionPersonasAt.get(message.path) ?? 0;
        if (now - last < SESSION_PERSONAS_MIN_INTERVAL_MS) return;
        pruneFloodGuard(lastSessionPersonasAt, now, SESSION_PERSONAS_MIN_INTERVAL_MS);
        lastSessionPersonasAt.set(message.path, now);

        try {
          const sessions = options.sessionManager
            .list()
            .filter((s) => s.projectPath === message.path)
            .map((s) => ({ sessionId: s.id, workItemId: s.workItemId, role: s.role }));
          const personas = await readSessionPersonas(message.path, sessions);
          sendFrame(socket, { type: 'session-personas', path: message.path, personas });
        } catch (err) {
          console.error('[ws] session-personas read failed', err);
        }
        return;
      }

      // Roster-timeline read: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'roster-timeline') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME path within the min-interval on
        // this socket. Distinct paths (the per-project fan-out) always pass.
        const now = Date.now();
        const last = lastRosterTimelineAt.get(message.path) ?? 0;
        if (now - last < ROSTER_TIMELINE_MIN_INTERVAL_MS) return;
        pruneFloodGuard(lastRosterTimelineAt, now, ROSTER_TIMELINE_MIN_INTERVAL_MS);
        lastRosterTimelineAt.set(message.path, now);

        try {
          sendFrame(socket, {
            type: 'roster-timeline',
            path: message.path,
            roles: buildRosterTimeline(readRoster(message.path)),
          });
        } catch (err) {
          console.error('[ws] roster-timeline read failed', err);
        }
        return;
      }

      // Work-item-sessions read: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'work-item-sessions-request') {
        // Access control: only read pinned projects (see isPinnedPath).
        if (!isPinnedPath(message.path)) return;
        // Flood-guard: drop repeats of the SAME (path, workItemId) key within the
        // min-interval on this socket. Distinct keys (the per-work-item fan-out)
        // always pass.
        const key = `${message.path} ${message.workItemId}`;
        const now = Date.now();
        const last = lastWorkItemSessionsAt.get(key) ?? 0;
        if (now - last < WORK_ITEM_SESSIONS_MIN_INTERVAL_MS) return;
        pruneFloodGuard(lastWorkItemSessionsAt, now, WORK_ITEM_SESSIONS_MIN_INTERVAL_MS);
        lastWorkItemSessionsAt.set(key, now);

        try {
          const rows = options.sessionStore.listByWorkItem(message.workItemId, message.path);
          const sessions = rows.map((row) => ({
            id: row.id,
            role: row.role,
            status: row.status,
            sdkSessionId: row.sdkSessionId,
            currentStage: row.currentStage,
            createdAt: row.createdAt,
          }));
          sendFrame(socket, {
            type: 'work-item-sessions',
            path: message.path,
            workItemId: message.workItemId,
            sessions,
          });
        } catch (err) {
          console.error('[ws] work-item-sessions read failed', err);
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

      // Transcript backfill: reply to the requesting socket only (never broadcast).
      // The whole flow is guarded so a read failure never crashes the gateway.
      if (message.type === 'session-transcript-request') {
        // Resolve the owning session; an unknown/ended session is a silent no-op
        // (the buffer is live-only — discarded at session end).
        const snap = options.sessionManager.get(message.sessionId);
        if (snap === null) return;
        // Access control: only serve sessions owned by a pinned project (fails closed).
        if (!isPinnedPath(snap.projectPath)) return;
        // Flood-guard: drop repeats of the SAME sessionId within the min-interval on
        // this socket. Distinct sessions (the per-session fan-out) always pass.
        const now = Date.now();
        const last = lastTranscriptRequestAt.get(message.sessionId) ?? 0;
        if (now - last < SESSION_TRANSCRIPT_REQUEST_MIN_INTERVAL_MS) return;
        pruneFloodGuard(lastTranscriptRequestAt, now, SESSION_TRANSCRIPT_REQUEST_MIN_INTERVAL_MS);
        lastTranscriptRequestAt.set(message.sessionId, now);

        try {
          const events = options.sessionManager.getTranscript(message.sessionId);
          sendFrame(socket, {
            type: 'session-transcript',
            path: snap.projectPath,
            sessionId: message.sessionId,
            events,
          });
        } catch (err) {
          console.error('[ws] session-transcript backfill failed', err);
        }
        return;
      }

      // Steer: push mid-run user text into a live owned session's input stream.
      // Same resolve → isPinnedPath fail-closed gate as session-transcript-request
      // (an unknown/ended session or an unpinned project is a silent no-op). No
      // flood-guard: this is a deliberate user action, like session-spawn. The reply
      // (and the user-text echo) flow back through the existing session-transcript
      // broadcast — nothing to send from here.
      if (message.type === 'session-input') {
        const snap = options.sessionManager.get(message.sessionId);
        if (snap === null) return;
        if (!isPinnedPath(snap.projectPath)) return;
        try {
          options.sessionManager.sendInput(message.sessionId, message.text);
        } catch (err) {
          console.error('[ws] session-input failed', err);
        }
        return;
      }

      // Interrupt: abort a live owned session's current turn (the session stays
      // running). Same fail-closed gate as session-input.
      if (message.type === 'session-interrupt') {
        const snap = options.sessionManager.get(message.sessionId);
        if (snap === null) return;
        if (!isPinnedPath(snap.projectPath)) return;
        try {
          await options.sessionManager.interrupt(message.sessionId);
        } catch (err) {
          console.error('[ws] session-interrupt failed', err);
        }
        return;
      }

      // Permission decision: resolve an outstanding permission request on a live
      // owned session. Same resolve → isPinnedPath fail-closed gate as
      // session-input (an unknown/ended session or an unpinned project is a
      // silent no-op). No flood-guard: this is a deliberate user action, like
      // session-input.
      if (message.type === 'permission-decision') {
        const snap = options.sessionManager.get(message.sessionId);
        if (snap === null) return;
        if (!isPinnedPath(snap.projectPath)) return;
        try {
          options.sessionManager.resolvePermission(message.sessionId, message.requestId, message.decision);
        } catch (err) {
          console.error('[ws] permission-decision failed', err);
        }
        return;
      }

      // Bridge start: begin (or resume) a pipeline run for a pinned project. Mirrors
      // session-spawn's two-layer access control (pinned + within project roots) since
      // it ultimately spawns an owned session; fails closed on either check.
      if (message.type === 'bridge-start') {
        if (!isPinnedPath(message.path)) return;
        if (!(await isWithinProjectRoots(message.path, options.projectRoots))) {
          console.warn('[ws] rejected bridge-start — path outside project roots');
          return;
        }
        try {
          options.bridge.start(message.path, message.workItemId);
        } catch (err) {
          console.error('[ws] bridge-start failed', err);
        }
        return;
      }

      // Gate approve: advance a paused Bridge run for a pinned project (fails closed).
      if (message.type === 'gate-approve') {
        if (!isPinnedPath(message.path)) return;
        try {
          options.bridge.approveGate(message.path);
        } catch (err) {
          console.error('[ws] gate-approve failed', err);
        }
        return;
      }

      // Gate request-changes: send a paused Bridge run back to coding for a pinned
      // project (fails closed, mirrors gate-approve).
      if (message.type === 'gate-request-changes') {
        if (!isPinnedPath(message.path)) return;
        try {
          options.bridge.requestChanges(message.path, message.notes);
        } catch (err) {
          console.error('[ws] gate-request-changes failed', err);
        }
        return;
      }

      // Question answer: resolve a parked agent question for a pinned project's run
      // (fails closed, mirrors gate-approve).
      if (message.type === 'question-answer') {
        if (!isPinnedPath(message.path)) return;
        try {
          options.bridge.answerQuestion(message.path, message.answer);
        } catch (err) {
          console.error('[ws] question-answer failed', err);
        }
        return;
      }

      // Escalation choice: resolve the current escalation for a pinned project's run
      // (fails closed, mirrors gate-approve).
      if (message.type === 'escalation-choice') {
        if (!isPinnedPath(message.path)) return;
        try {
          options.bridge.resolveEscalation(message.path, message.choice, message.notes);
        } catch (err) {
          console.error('[ws] escalation-choice failed', err);
        }
        return;
      }

      // Bridge interrupt: pause a running Bridge run for a pinned project (fails closed).
      if (message.type === 'bridge-interrupt') {
        if (!isPinnedPath(message.path)) return;
        try {
          options.bridge.interrupt(message.path, 'interrupt', message.reason);
        } catch (err) {
          console.error('[ws] bridge-interrupt failed', err);
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
      clearInterval(hookStaleInterval);
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
