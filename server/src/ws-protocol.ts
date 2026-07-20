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

/** Every message the server accepts from a client. */
export type InboundMessage = PinMessage | UnpinMessage;

/** Every registry message the server emits to a client. */
export type OutboundMessage = RegistrySnapshot | RegistryError;

/**
 * Validate a raw WS frame against the inbound contract. Accepts only a JSON string
 * describing a `pin` or `unpin` message with a non-empty ABSOLUTE `path`.
 * Returns a new frozen message, or null for anything malformed. Never throws.
 */
export function parseInboundMessage(data: unknown): PinMessage | UnpinMessage | null {
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
  const { type, path } = frame;

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

  if (type === 'pin') {
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
