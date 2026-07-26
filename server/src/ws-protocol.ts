// WebSocket protocol contract (SERVER side) + inbound boundary validator.
//
// This is the server half of a duplicate-typed-contract: the web client mirrors
// these interfaces separately (no shared workspace package). Keep the two in sync
// by hand — the wire shapes here are the single source of truth for the server.
//
// Design notes:
//  - Immutable: every interface is fully readonly; the validator returns new objects.
//  - Boundary validation: `parseInboundMessage` shape-checks every raw frame and
//    NEVER throws — malformed input yields null, mirroring web/src/lib/ws-client.ts.
//  - No on-disk checks here: path existence/discovery is deferred to a later task.

import { isAbsolute } from 'node:path';
import { isValidRole } from './session/roles.js';

// Boundary size limits (defense-in-depth for the first client-writable surface).
// The transport also enforces MAX_WS_PAYLOAD_BYTES via the WebSocketServer, but
// the validator caps individual fields so oversized values never reach the store.
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024; // 64 KiB per frame
const MAX_FRAME_CHARS = MAX_WS_PAYLOAD_BYTES; // reject an over-long raw frame early
const MAX_PATH_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 512;
const MAX_WORK_ITEM_ID_LENGTH = 512;

/** A persisted project anchor as sent to the client. */
export interface ProjectAnchor {
  readonly path: string;
  readonly displayName: string | null;
  readonly pinned: boolean;
  readonly uiPrefs: unknown;
  readonly createdAt: number;
}

/** Inbound: pin (create/update) a project anchor. */
export interface PinMessage {
  readonly type: 'pin';
  readonly path: string;
  readonly displayName?: string;
  readonly uiPrefs?: unknown;
}

/** Inbound: remove a project anchor. */
export interface UnpinMessage {
  readonly type: 'unpin';
  readonly path: string;
}

/** Outbound: full snapshot of the current registry. */
export interface RegistrySnapshot {
  readonly type: 'registry';
  readonly projects: readonly ProjectAnchor[];
}

/** Outbound: a registry operation failed. */
export interface RegistryError {
  readonly type: 'registry:error';
  readonly op: string;
  readonly path: string;
  readonly message: string;
}

/** A discovered project candidate (not yet pinned) as sent to the client. */
export interface Candidate {
  readonly path: string;
  readonly displayName: string | null;
  readonly hasClaudeInstall: boolean;
}

/** Inbound: request a fresh discovery of candidate projects. */
export interface DiscoverMessage {
  readonly type: 'discover';
}

/** Outbound: full snapshot of the current discovery candidates. */
export interface CandidatesSnapshot {
  readonly type: 'candidates';
  readonly candidates: readonly Candidate[];
}

/** The git state of a project working tree as sent to the client. */
export interface GitState {
  readonly path: string;
  readonly isRepo: boolean;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly upstream: string | null;
}

/** Inbound: request the current git state for a project path. */
export interface GitStateMessage {
  readonly type: 'git-state';
  readonly path: string;
}

/** Outbound: a git-state snapshot for a single project path. */
export interface GitStateSnapshot {
  readonly type: 'git-state';
  readonly path: string;
  readonly state: GitState;
}

/** The top open tracker item for a project, as sent to the client. */
export interface TrackerTask {
  readonly id: string;
  readonly title: string;
  readonly priority: number | null;
  readonly url: string | null;
}

/** The tracker state of a project as sent to the client. */
export interface TrackerState {
  readonly path: string;
  readonly reachable: boolean;
  readonly tracker: string | null;
  readonly nextTask: TrackerTask | null;
}

/** Inbound: request the current tracker state for a project path. */
export interface TrackerStateMessage {
  readonly type: 'tracker-state';
  readonly path: string;
}

/** Outbound: a tracker-state snapshot for a single project path. */
export interface TrackerStateSnapshot {
  readonly type: 'tracker-state';
  readonly path: string;
  readonly state: TrackerState;
}

// The whole-project lifecycle STAGE (New→Decide→Define→Build→Ship) is derived on
// the CLIENT (web/src/lib/lifecycle.ts) so it can REUSE the per-card git-state and
// tracker-state reads the grid already performs (ARCHITECTURE §9.2/§9.6: "reuses the
// per-card local + tracker reads") — the server does NOT re-shell the tracker or
// re-run `git status` for the lifecycle. The server only supplies the extra signals
// the client can't derive from git-state/tracker-state: local planning files, story
// state, release tags, and feature-branch commits. The stage type itself lives on
// the client.

/**
 * The server-derived lifecycle signals a client can't get from git-state/tracker-state.
 * The client combines these with its already-fetched tracker-state (wayfinder:map →
 * Decide, an open task → Define) and computes the final stage via max(precedence).
 */
export interface LifecycleSignals {
  /** A decision artifact — grill-summary.md / decision-brief.md (→ Decide). */
  readonly hasDecideDocs: boolean;
  /** A planning artifact — docs/SPEC.md / docs/ARCHITECTURE.md / PRD.md (→ Define). */
  readonly hasDefineDocs: boolean;
  /** A genuinely started tasks/stories/<id>/ (executor-state w/ Progress) (→ Build). */
  readonly hasStartedStory: boolean;
  /** On a non-default branch that resolves to at least one commit (→ Build). */
  readonly hasFeatureBranchCommits: boolean;
  /** At least one release tag (→ Ship). codePlatform:none, so tags are the honest floor. */
  readonly hasReleaseTags: boolean;
}

/** The lifecycle-signals snapshot of a project as sent to the client. */
export interface LifecycleSignalsState {
  readonly path: string;
  readonly signals: LifecycleSignals;
}

/** Inbound: request the current lifecycle signals for a project path. */
export interface LifecycleSignalsMessage {
  readonly type: 'lifecycle-signals';
  readonly path: string;
}

/** Outbound: a lifecycle-signals snapshot for a single project path. */
export interface LifecycleSignalsSnapshot {
  readonly type: 'lifecycle-signals';
  readonly path: string;
  readonly state: LifecycleSignalsState;
}

/** One owned session's live state, as sent to the client. */
export interface SessionState {
  readonly id: string;
  readonly projectPath: string;
  readonly role: string;
  readonly status: string;
  readonly sdkSessionId: string | null;
}

/** Inbound: spawn an owned Agent-SDK session for a pinned project + role. */
export interface SessionSpawnMessage {
  readonly type: 'session-spawn';
  readonly path: string;
  readonly role: string;
  readonly workItemId?: string;
}

/** Outbound: a live-state snapshot for a single owned session. */
export interface SessionStateSnapshot {
  readonly type: 'session-state';
  readonly path: string;
  readonly session: SessionState;
}

/** Every message the server accepts from a client. */
export type InboundMessage =
  | PinMessage
  | UnpinMessage
  | DiscoverMessage
  | GitStateMessage
  | TrackerStateMessage
  | LifecycleSignalsMessage
  | SessionSpawnMessage;

/** Every registry message the server emits to a client. */
export type OutboundMessage =
  | RegistrySnapshot
  | RegistryError
  | CandidatesSnapshot
  | GitStateSnapshot
  | TrackerStateSnapshot
  | LifecycleSignalsSnapshot
  | SessionStateSnapshot;

/**
 * Validate a raw WS frame against the inbound contract. Branches on `type` first:
 * a `discover` frame carries no `path`; `pin`/`unpin` require a non-empty ABSOLUTE
 * `path`. Returns a new frozen message, or null for anything malformed. Never throws.
 */
export function parseInboundMessage(data: unknown): InboundMessage | null {
  if (typeof data !== 'string') return null;
  if (data.length > MAX_FRAME_CHARS) return null; // oversized frame — drop before parsing

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  const { type } = frame;

  // `discover` carries no payload — no path validation.
  if (type === 'discover') {
    return Object.freeze<DiscoverMessage>({ type: 'discover' });
  }

  // `git-state` shares the same non-empty ABSOLUTE-path requirement as pin/unpin.
  if (type === 'git-state') {
    const { path } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }
    return Object.freeze<GitStateMessage>({ type: 'git-state', path });
  }

  // `tracker-state` shares the same non-empty ABSOLUTE-path requirement as git-state.
  if (type === 'tracker-state') {
    const { path } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }
    return Object.freeze<TrackerStateMessage>({ type: 'tracker-state', path });
  }

  // `lifecycle-signals` shares the same non-empty ABSOLUTE-path requirement as tracker-state.
  if (type === 'lifecycle-signals') {
    const { path } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }
    return Object.freeze<LifecycleSignalsMessage>({ type: 'lifecycle-signals', path });
  }

  // `session-spawn` requires a non-empty ABSOLUTE path (like the read frames) AND a
  // valid role (validated against the canonical roster). workItemId is optional.
  if (type === 'session-spawn') {
    const { path, role, workItemId } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }
    if (!isValidRole(role)) {
      return null;
    }
    // workItemId is optional; when present it must be a bounded string (it is persisted
    // to the sessions table — reject, don't truncate, so the boundary stays strict).
    if (
      workItemId !== undefined &&
      (typeof workItemId !== 'string' || workItemId.length > MAX_WORK_ITEM_ID_LENGTH)
    ) {
      return null;
    }
    return Object.freeze<SessionSpawnMessage>({
      type: 'session-spawn',
      path,
      role,
      // Conditional spread keeps workItemId absent (never `undefined`) for exactOptionalPropertyTypes.
      ...(typeof workItemId === 'string' ? { workItemId } : {}),
    });
  }

  // `pin`/`unpin` share the absolute-path requirement.
  if (type === 'pin' || type === 'unpin') {
    const { path } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }

    if (type === 'unpin') {
      return Object.freeze<UnpinMessage>({ type: 'unpin', path });
    }

    const { displayName, uiPrefs } = frame;
    // An over-long displayName is rejected (not truncated) so the boundary stays strict.
    if (typeof displayName === 'string' && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return null;
    }
    return Object.freeze<PinMessage>({
      type: 'pin',
      path,
      // Conditional spreads keep optional fields absent (never `undefined`) so the
      // result satisfies exactOptionalPropertyTypes.
      ...(typeof displayName === 'string' ? { displayName } : {}),
      ...('uiPrefs' in frame ? { uiPrefs } : {}),
    });
  }

  return null;
}
