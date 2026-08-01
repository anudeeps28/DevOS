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
import type { Phase } from './lifecycle/story-state-reader.js';

// Boundary size limits (defense-in-depth for the first client-writable surface).
// The transport also enforces MAX_WS_PAYLOAD_BYTES via the WebSocketServer, but
// the validator caps individual fields so oversized values never reach the store.
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024; // 64 KiB per frame
const MAX_FRAME_CHARS = MAX_WS_PAYLOAD_BYTES; // reject an over-long raw frame early
const MAX_PATH_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 512;
const MAX_WORK_ITEM_ID_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_REASON_LENGTH = 4096;
export const MAX_STEER_TEXT_LENGTH = 8192;
export const MAX_REQUEST_ID_LENGTH = 128;

// A workItemId is later joined into a filesystem path (tasks/stories/<id>/phase.md
// by the persona reader), so it must be a safe single path segment — no separators,
// no `..`, no leading dot. Allowlist strictly (reject, don't sanitize) at the
// boundary so a traversal payload can never reach any path join downstream.
const WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
function isSafeWorkItemId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WORK_ITEM_ID_LENGTH &&
    WORK_ITEM_ID_PATTERN.test(value)
  );
}

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
  /** The started story's live phase.md marker (rules/phase-markers.md), or null. */
  readonly phase: Phase | null;
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
  readonly workItemId: string | null;
  readonly rateLimited: boolean;
}

/** One owned session's persona identity — role x its story's live phase, joined against the roster. */
export interface SessionPersona {
  readonly sessionId: string;
  readonly workItemId: string | null;
  readonly role: string;
  readonly phase: Phase | null;
  readonly persona: string | null;
}

/** Inbound: request the current persona join for every owned session of a pinned project path. */
export interface SessionPersonasMessage {
  readonly type: 'session-personas';
  readonly path: string;
}

/** Outbound: a session-personas snapshot for a single project path. */
export interface SessionPersonasSnapshot {
  readonly type: 'session-personas';
  readonly path: string;
  readonly personas: readonly SessionPersona[];
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

/**
 * One normalized transcript event body — the payload of a live session's SDK
 * message stream after normalization (see session/transcript-events.ts).
 * Discriminated on `kind`.
 */
export type TranscriptEventBody =
  | { readonly kind: 'init' }
  | { readonly kind: 'assistant-text'; readonly text: string }
  | {
      readonly kind: 'tool-use';
      readonly toolName: string;
      readonly toolInput: string;
      readonly toolUseId: string | null;
    }
  | {
      readonly kind: 'tool-result';
      readonly toolUseId: string | null;
      readonly content: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: 'result';
      readonly durationMs: number;
      readonly numTurns: number;
      readonly totalCostUsd: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly isError: boolean;
    }
  | { readonly kind: 'user-text'; readonly text: string }
  | {
      readonly kind: 'permission';
      readonly requestId: string;
      readonly toolName: string;
      readonly decision: 'allow' | 'deny';
    };

/** A transcript event body stamped with its session identity + ordering. */
export type TranscriptEvent = TranscriptEventBody & {
  readonly sessionId: string;
  readonly seq: number;
  readonly ts: number;
};

/** Outbound: a batch of transcript events for a single owned session. */
export interface SessionTranscriptSnapshot {
  readonly type: 'session-transcript';
  readonly path: string;
  readonly sessionId: string;
  readonly events: readonly TranscriptEvent[];
}

/** Inbound: request the buffered transcript of a live owned session (backfill). */
export interface SessionTranscriptRequestMessage {
  readonly type: 'session-transcript-request';
  readonly sessionId: string;
}

/** Inbound: steer a live owned session with mid-run user text. */
export interface SessionInputMessage {
  readonly type: 'session-input';
  readonly sessionId: string;
  readonly text: string;
}

/** Inbound: interrupt a live owned session. */
export interface SessionInterruptMessage {
  readonly type: 'session-interrupt';
  readonly sessionId: string;
}

/** Outbound: a permission request raised by a live owned session, awaiting a decision. */
export interface PermissionRequestSnapshot {
  readonly type: 'permission-request';
  readonly path: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly toolUseId: string | null;
  readonly toolName: string;
  readonly title: string | null;
  readonly input: string;
}

/** Inbound: the user's decision on an outstanding permission request. */
export interface PermissionDecisionMessage {
  readonly type: 'permission-decision';
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: 'allow' | 'deny';
}

/** Inbound: start (or resume) a Bridge run for a pinned project path. */
export interface BridgeStartMessage {
  readonly type: 'bridge-start';
  readonly path: string;
  readonly workItemId?: string;
}

/** Inbound: approve the current Bridge gate for a pinned project path. */
export interface GateApproveMessage {
  readonly type: 'gate-approve';
  readonly path: string;
}

/** Inbound: interrupt the running Bridge for a pinned project path. */
export interface BridgeInterruptMessage {
  readonly type: 'bridge-interrupt';
  readonly path: string;
  readonly reason: string;
}

/** The gate a Bridge run is currently sitting at, as sent to the client. */
export type BridgeGate = 'running' | 'awaiting-approval' | 'reworking' | 'escalated' | 'done';

/** One item in a Bridge run's inbox — an interrupt, question, or escalation. */
export interface BridgeInboxItem {
  readonly stage: string;
  readonly kind: 'interrupt' | 'question' | 'escalation';
  readonly reason: string;
  readonly ts: number;
}

/** Outbound: a live-state snapshot for a single Bridge run. */
export interface BridgeStateSnapshot {
  readonly type: 'bridge-state';
  readonly path: string;
  readonly stage: string;
  readonly gate: BridgeGate;
  readonly sessionId: string | null;
  readonly inbox: readonly BridgeInboxItem[];
}

/**
 * Outbound: a foreign (not owned by this server instance) session that needs
 * human attention — a permission prompt, an idle prompt, or an agent asking
 * for input — surfaced from a gated cwd's hook activity. `path` is the gated
 * cwd; `cleared: true` means the UI removes the item (emitted on SessionEnd
 * for that sessionId).
 */
export interface ForeignSessionNeedsYouSnapshot {
  readonly type: 'foreign-session-needs-you';
  readonly path: string;
  readonly sessionId: string;
  readonly kind: 'permission_prompt' | 'idle_prompt' | 'agent_needs_input';
  readonly reason: string;
  readonly ts: number;
  readonly cleared: boolean;
}

/** Outbound: liveness of the HTTP-fed hook bus that feeds foreign-session signals. */
export interface HookBusLivenessSnapshot {
  readonly type: 'hook-bus-liveness';
  readonly connected: boolean;
  readonly lastReceivedAt: number | null;
}

/** Every message the server accepts from a client. */
export type InboundMessage =
  | PinMessage
  | UnpinMessage
  | DiscoverMessage
  | GitStateMessage
  | TrackerStateMessage
  | LifecycleSignalsMessage
  | SessionSpawnMessage
  | SessionTranscriptRequestMessage
  | SessionInputMessage
  | SessionInterruptMessage
  | PermissionDecisionMessage
  | BridgeStartMessage
  | GateApproveMessage
  | BridgeInterruptMessage
  | SessionPersonasMessage;

/** Every registry message the server emits to a client. */
export type OutboundMessage =
  | RegistrySnapshot
  | RegistryError
  | CandidatesSnapshot
  | GitStateSnapshot
  | TrackerStateSnapshot
  | LifecycleSignalsSnapshot
  | SessionStateSnapshot
  | SessionTranscriptSnapshot
  | PermissionRequestSnapshot
  | BridgeStateSnapshot
  | ForeignSessionNeedsYouSnapshot
  | HookBusLivenessSnapshot
  | SessionPersonasSnapshot;

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

  // `session-personas` shares the same non-empty ABSOLUTE-path requirement as lifecycle-signals.
  if (type === 'session-personas') {
    const { path } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }
    return Object.freeze<SessionPersonasMessage>({ type: 'session-personas', path });
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
    // workItemId is optional; when present it must be a safe path-segment string (it is
    // persisted to the sessions table AND later joined into a filesystem path by the
    // persona reader — reject anything with a separator/`..`, so the boundary stays strict).
    if (workItemId !== undefined && !isSafeWorkItemId(workItemId)) {
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

  // `session-transcript-request` carries a session id (opaque, not a path) — a
  // non-empty bounded string. Ownership/pinning is resolved by the gateway.
  if (type === 'session-transcript-request') {
    const { sessionId } = frame;
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > MAX_SESSION_ID_LENGTH
    ) {
      return null;
    }
    return Object.freeze<SessionTranscriptRequestMessage>({
      type: 'session-transcript-request',
      sessionId,
    });
  }

  // `session-interrupt` carries a session id (opaque, not a path) — a non-empty
  // bounded string, same shape as session-transcript-request.
  if (type === 'session-interrupt') {
    const { sessionId } = frame;
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > MAX_SESSION_ID_LENGTH
    ) {
      return null;
    }
    return Object.freeze<SessionInterruptMessage>({
      type: 'session-interrupt',
      sessionId,
    });
  }

  // `session-input` carries a session id (like session-interrupt) plus a bounded
  // steering text. An over-long text is rejected (not truncated) so the boundary
  // stays strict.
  if (type === 'session-input') {
    const { sessionId, text } = frame;
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > MAX_SESSION_ID_LENGTH
    ) {
      return null;
    }
    if (typeof text !== 'string' || text.length > MAX_STEER_TEXT_LENGTH) {
      return null;
    }
    return Object.freeze<SessionInputMessage>({
      type: 'session-input',
      sessionId,
      text,
    });
  }

  // `permission-decision` carries a session id (like session-interrupt) plus a
  // request id and a decision that must be exactly 'allow' or 'deny'.
  if (type === 'permission-decision') {
    const { sessionId, requestId, decision } = frame;
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > MAX_SESSION_ID_LENGTH
    ) {
      return null;
    }
    if (
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      requestId.length > MAX_REQUEST_ID_LENGTH
    ) {
      return null;
    }
    if (decision !== 'allow' && decision !== 'deny') {
      return null;
    }
    return Object.freeze<PermissionDecisionMessage>({
      type: 'permission-decision',
      sessionId,
      requestId,
      decision,
    });
  }

  // `bridge-start` requires a non-empty ABSOLUTE path (like session-spawn). workItemId
  // is optional and shares the same bounded-string requirement.
  if (type === 'bridge-start') {
    const { path, workItemId } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }
    if (workItemId !== undefined && !isSafeWorkItemId(workItemId)) {
      return null;
    }
    return Object.freeze<BridgeStartMessage>({
      type: 'bridge-start',
      path,
      // Conditional spread keeps workItemId absent (never `undefined`) for exactOptionalPropertyTypes.
      ...(typeof workItemId === 'string' ? { workItemId } : {}),
    });
  }

  // `gate-approve` shares the same non-empty ABSOLUTE-path requirement as git-state.
  if (type === 'gate-approve') {
    const { path } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }
    return Object.freeze<GateApproveMessage>({ type: 'gate-approve', path });
  }

  // `bridge-interrupt` requires the same ABSOLUTE path plus a bounded reason string.
  if (type === 'bridge-interrupt') {
    const { path, reason } = frame;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      !isAbsolute(path)
    ) {
      return null;
    }
    if (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH) {
      return null;
    }
    return Object.freeze<BridgeInterruptMessage>({ type: 'bridge-interrupt', path, reason });
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
