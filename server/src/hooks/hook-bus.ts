// Hook bus — parses raw Claude Code hook payloads (posted by the hook forwarder
// over HTTP, see .claude/hooks/lib/hook-io.js) into a typed, immutable shape and
// fans them out as liveness/event signals for the server to consume.
//
// Design notes (mirrors ws-protocol.ts's parseInboundMessage pattern):
//  - Immutable: every interface is fully readonly; parseHookPayload returns a
//    frozen object (or null).
//  - Boundary validation: parseHookPayload NEVER throws — malformed/hostile
//    input yields null.
//  - Pure module: no SDK, no ws import.

import { isAbsolute } from 'node:path';
import { HOOK_STALE_MS } from '../config.js';

const MAX_SESSION_ID_LENGTH = 128;
const MAX_CWD_LENGTH = 4096;
const MAX_REASON_LENGTH = 4096;

const NOTIFICATION_KINDS: ReadonlySet<string> = new Set([
  'permission_prompt',
  'idle_prompt',
  'agent_needs_input',
]);

type NotificationKind = 'permission_prompt' | 'idle_prompt' | 'agent_needs_input';

const DEFAULT_REASON_BY_KIND: Readonly<Record<NotificationKind, string>> = {
  permission_prompt: 'Waiting on a permission decision.',
  idle_prompt: 'Session is idle, waiting for input.',
  agent_needs_input: 'Agent needs input to continue.',
};

/** A defensively-parsed Claude Code hook payload. */
export type ParsedHook =
  | {
      readonly event: 'notification';
      readonly sessionId: string;
      readonly cwd: string;
      readonly kind: NotificationKind;
      readonly reason: string;
    }
  | { readonly event: 'session-start'; readonly sessionId: string; readonly cwd: string }
  | { readonly event: 'session-end'; readonly sessionId: string; readonly cwd: string };

/**
 * Validate a raw hook payload (as posted by the hook forwarder). Returns a new
 * frozen `ParsedHook`, or null for anything malformed/unexpected. Never throws.
 */
export function parseHookPayload(raw: unknown): ParsedHook | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;

  const sessionId = body.session_id;
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > MAX_SESSION_ID_LENGTH
  ) {
    return null;
  }

  const cwd = body.cwd;
  if (
    typeof cwd !== 'string' ||
    cwd.length === 0 ||
    cwd.length > MAX_CWD_LENGTH ||
    !isAbsolute(cwd)
  ) {
    return null;
  }

  const hookEventName = body.hook_event_name;
  if (typeof hookEventName !== 'string') return null;

  if (hookEventName === 'Notification') {
    const notificationType = body.notification_type;
    if (typeof notificationType !== 'string' || !NOTIFICATION_KINDS.has(notificationType)) {
      return null;
    }
    const kind = notificationType as NotificationKind;

    const rawMessage = body.message;
    const reason =
      typeof rawMessage === 'string' && rawMessage.length > 0
        ? rawMessage.slice(0, MAX_REASON_LENGTH)
        : DEFAULT_REASON_BY_KIND[kind];

    return Object.freeze<ParsedHook>({
      event: 'notification',
      sessionId,
      cwd,
      kind,
      reason,
    });
  }

  if (hookEventName === 'SessionStart') {
    return Object.freeze<ParsedHook>({ event: 'session-start', sessionId, cwd });
  }

  if (hookEventName === 'SessionEnd') {
    return Object.freeze<ParsedHook>({ event: 'session-end', sessionId, cwd });
  }

  return null;
}

/** A liveness-derived event the bus emits to subscribers. */
export type HookEvent =
  | {
      readonly kind: 'needs-you';
      readonly sessionId: string;
      readonly cwd: string;
      readonly notifKind: NotificationKind;
      readonly reason: string;
      readonly ts: number;
    }
  | { readonly kind: 'clear'; readonly sessionId: string; readonly cwd: string; readonly ts: number };

type EventListener = (e: HookEvent) => void;
type LivenessListener = (connected: boolean, lastReceivedAt: number | null) => void;

/** In-memory bus: ingests raw hook payloads, fans out typed events + liveness. */
export interface HookBus {
  ingest(raw: unknown): void;
  onEvent(l: EventListener): () => void;
  onLiveness(l: LivenessListener): () => void;
  getLiveness(now: number): { connected: boolean; lastReceivedAt: number | null };
  checkStale(now: number): void;
}

/**
 * Create a fresh in-memory hook bus. `now` defaults to `Date.now`; `staleMs`
 * defaults to `HOOK_STALE_MS`. Every subscriber callback is wrapped in
 * try/catch so a bad subscriber can never break the bus.
 */
export function createHookBus(opts?: { now?: () => number; staleMs?: number }): HookBus {
  const now = opts?.now ?? Date.now;
  const staleMs = opts?.staleMs ?? HOOK_STALE_MS;

  let lastReceivedAt: number | null = null;
  let wasConnected = false;
  const eventListeners = new Set<EventListener>();
  const livenessListeners = new Set<LivenessListener>();

  function emitEvent(e: HookEvent): void {
    for (const listener of eventListeners) {
      try {
        listener(e);
      } catch {
        // A bad subscriber must never break the bus.
      }
    }
  }

  function emitLiveness(connected: boolean, at: number | null): void {
    wasConnected = connected;
    for (const listener of livenessListeners) {
      try {
        listener(connected, at);
      } catch {
        // A bad subscriber must never break the bus.
      }
    }
  }

  return {
    ingest(raw: unknown): void {
      const parsed = parseHookPayload(raw);
      if (parsed === null) return;

      const ts = now();
      lastReceivedAt = ts;
      console.log('[hooks] hook received', parsed.event);
      emitLiveness(true, lastReceivedAt);

      if (parsed.event === 'notification') {
        emitEvent({
          kind: 'needs-you',
          sessionId: parsed.sessionId,
          cwd: parsed.cwd,
          notifKind: parsed.kind,
          reason: parsed.reason,
          ts,
        });
      } else if (parsed.event === 'session-end') {
        emitEvent({ kind: 'clear', sessionId: parsed.sessionId, cwd: parsed.cwd, ts });
      }
      // 'session-start' only updates liveness — no event emitted.
    },

    onEvent(l: EventListener): () => void {
      eventListeners.add(l);
      return () => eventListeners.delete(l);
    },

    onLiveness(l: LivenessListener): () => void {
      livenessListeners.add(l);
      return () => livenessListeners.delete(l);
    },

    getLiveness(nowMs: number): { connected: boolean; lastReceivedAt: number | null } {
      const connected = lastReceivedAt !== null && nowMs - lastReceivedAt < staleMs;
      return { connected, lastReceivedAt };
    },

    checkStale(nowMs: number): void {
      if (wasConnected && !this.getLiveness(nowMs).connected) {
        emitLiveness(false, lastReceivedAt);
      }
    },
  };
}
