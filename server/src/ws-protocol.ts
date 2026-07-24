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

// Boundary size limits (defense-in-depth for the first client-writable surface).
// The transport also enforces MAX_WS_PAYLOAD_BYTES via the WebSocketServer, but
// the validator caps individual fields so oversized values never reach the store.
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024; // 64 KiB per frame
const MAX_FRAME_CHARS = MAX_WS_PAYLOAD_BYTES; // reject an over-long raw frame early
const MAX_PATH_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 512;

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

/** Every message the server accepts from a client. */
export type InboundMessage = PinMessage | UnpinMessage | DiscoverMessage | GitStateMessage;

/** Every registry message the server emits to a client. */
export type OutboundMessage =
  | RegistrySnapshot
  | RegistryError
  | CandidatesSnapshot
  | GitStateSnapshot;

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
