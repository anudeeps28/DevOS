import { describe, expect, it } from 'vitest';

import { createHookBus, parseHookPayload, type HookEvent, type ParsedHook } from './hook-bus.js';

const ABS_CWD = '/abs/project';

function notification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    cwd: ABS_CWD,
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    ...overrides,
  };
}

describe('parseHookPayload', () => {
  describe('drops malformed/hostile input (never throws)', () => {
    it('returns null for non-object input', () => {
      expect(parseHookPayload(42)).toBeNull();
      expect(parseHookPayload('a string')).toBeNull();
      expect(parseHookPayload(null)).toBeNull();
      expect(parseHookPayload(undefined)).toBeNull();
      expect(parseHookPayload([1, 2, 3])).toBeNull();
    });

    it('returns null for a missing or blank session_id', () => {
      expect(parseHookPayload(notification({ session_id: undefined }))).toBeNull();
      expect(parseHookPayload(notification({ session_id: '' }))).toBeNull();
    });

    it('returns null for a missing, blank, or relative cwd', () => {
      expect(parseHookPayload(notification({ cwd: undefined }))).toBeNull();
      expect(parseHookPayload(notification({ cwd: '' }))).toBeNull();
      expect(parseHookPayload(notification({ cwd: 'relative/dir' }))).toBeNull();
    });

    it('returns null for an unknown hook_event_name', () => {
      expect(parseHookPayload(notification({ hook_event_name: 'Frobnicate' }))).toBeNull();
      expect(parseHookPayload(notification({ hook_event_name: undefined }))).toBeNull();
    });

    it('returns null for a Notification with an unknown or absent notification_type', () => {
      expect(parseHookPayload(notification({ notification_type: 'unknown_type' }))).toBeNull();
      expect(parseHookPayload(notification({ notification_type: undefined }))).toBeNull();
    });

    it('returns null for an oversized session_id', () => {
      expect(parseHookPayload(notification({ session_id: 's'.repeat(129) }))).toBeNull();
    });

    it('returns null for an oversized cwd', () => {
      const cwd = '/' + 'a'.repeat(4096);
      expect(parseHookPayload(notification({ cwd }))).toBeNull();
    });

    it('truncates an oversized message rather than rejecting the payload', () => {
      const message = 'x'.repeat(5000);
      const result = parseHookPayload(notification({ message }));
      expect(result).not.toBeNull();
      if (result?.event === 'notification') {
        expect(result.reason.length).toBeLessThanOrEqual(4096);
      }
    });

    it('never throws on hostile input', () => {
      const inputs: unknown[] = [
        42,
        'a string',
        null,
        undefined,
        [1, 2, 3],
        { a: { b: { c: { d: { e: 'deep' } } } } },
        { session_id: 'x'.repeat(1_000_000) },
        { session_id: 1, cwd: 2, hook_event_name: 3, notification_type: 4, message: 5 },
        notification({ session_id: {} }),
        notification({ cwd: [] }),
        notification({ message: 'z'.repeat(1_000_000) }),
      ];

      for (const input of inputs) {
        expect(() => parseHookPayload(input)).not.toThrow();
      }
    });
  });

  describe('maps valid payloads', () => {
    it('maps Notification + permission_prompt', () => {
      const result = parseHookPayload(
        notification({ notification_type: 'permission_prompt', message: 'need a decision' }),
      );

      expect(result).toEqual<ParsedHook>({
        event: 'notification',
        sessionId: 'sess-1',
        cwd: ABS_CWD,
        kind: 'permission_prompt',
        reason: 'need a decision',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('maps Notification + idle_prompt', () => {
      const result = parseHookPayload(
        notification({ notification_type: 'idle_prompt', message: 'idle now' }),
      );

      expect(result).toEqual<ParsedHook>({
        event: 'notification',
        sessionId: 'sess-1',
        cwd: ABS_CWD,
        kind: 'idle_prompt',
        reason: 'idle now',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('maps Notification + agent_needs_input', () => {
      const result = parseHookPayload(
        notification({ notification_type: 'agent_needs_input', message: 'need input' }),
      );

      expect(result).toEqual<ParsedHook>({
        event: 'notification',
        sessionId: 'sess-1',
        cwd: ABS_CWD,
        kind: 'agent_needs_input',
        reason: 'need input',
      });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('falls back to a default reason when message is absent', () => {
      const result = parseHookPayload(notification({ notification_type: 'permission_prompt' }));
      expect(result).toEqual<ParsedHook>({
        event: 'notification',
        sessionId: 'sess-1',
        cwd: ABS_CWD,
        kind: 'permission_prompt',
        reason: 'Waiting on a permission decision.',
      });
    });

    it('strips CR/LF and C0 control chars from the reason (single-line hygiene)', () => {
      const result = parseHookPayload(
        notification({
          notification_type: 'permission_prompt',
          message: 'line one\r\nline two\tafter\u001B[31mred',
        }),
      );
      expect(result).not.toBeNull();
      const reason = (result as { reason: string }).reason;
      // CR, LF, TAB and ESC each become a single space; visible text is preserved.
      expect(reason).toBe('line one  line two after [31mred');
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001F\u007F]/.test(reason)).toBe(false);
    });

    it('maps SessionStart', () => {
      const result = parseHookPayload({
        session_id: 'sess-1',
        cwd: ABS_CWD,
        hook_event_name: 'SessionStart',
      });

      expect(result).toEqual<ParsedHook>({ event: 'session-start', sessionId: 'sess-1', cwd: ABS_CWD });
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('maps SessionEnd', () => {
      const result = parseHookPayload({
        session_id: 'sess-1',
        cwd: ABS_CWD,
        hook_event_name: 'SessionEnd',
      });

      expect(result).toEqual<ParsedHook>({ event: 'session-end', sessionId: 'sess-1', cwd: ABS_CWD });
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});

describe('createHookBus', () => {
  it('ingests a valid Notification and fires onEvent + onLiveness once', () => {
    const fakeNow = 1000;
    const bus = createHookBus({ now: () => fakeNow, staleMs: 5000 });

    const events: HookEvent[] = [];
    const liveness: Array<{ connected: boolean; lastReceivedAt: number | null }> = [];
    bus.onEvent((e) => events.push(e));
    bus.onLiveness((connected, lastReceivedAt) => liveness.push({ connected, lastReceivedAt }));

    bus.ingest(notification({ notification_type: 'agent_needs_input', message: 'hi' }));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual<HookEvent>({
      kind: 'needs-you',
      sessionId: 'sess-1',
      cwd: ABS_CWD,
      notifKind: 'agent_needs_input',
      reason: 'hi',
      ts: fakeNow,
    });
    expect(liveness).toHaveLength(1);
    expect(liveness[0]).toEqual({ connected: true, lastReceivedAt: fakeNow });
  });

  it('ingests SessionEnd and fires a clear event', () => {
    const fakeNow = 2000;
    const bus = createHookBus({ now: () => fakeNow, staleMs: 5000 });

    const events: HookEvent[] = [];
    bus.onEvent((e) => events.push(e));

    bus.ingest({ session_id: 'sess-1', cwd: ABS_CWD, hook_event_name: 'SessionEnd' });

    expect(events).toEqual<HookEvent[]>([
      { kind: 'clear', sessionId: 'sess-1', cwd: ABS_CWD, ts: fakeNow },
    ]);
  });

  it('ingests SessionStart and only updates liveness, no onEvent', () => {
    const fakeNow = 3000;
    const bus = createHookBus({ now: () => fakeNow, staleMs: 5000 });

    const events: HookEvent[] = [];
    const liveness: Array<{ connected: boolean }> = [];
    bus.onEvent((e) => events.push(e));
    bus.onLiveness((connected) => liveness.push({ connected }));

    bus.ingest({ session_id: 'sess-1', cwd: ABS_CWD, hook_event_name: 'SessionStart' });

    expect(events).toHaveLength(0);
    expect(liveness).toEqual([{ connected: true }]);
  });

  it('a dropped payload fires neither onEvent nor onLiveness and does not throw', () => {
    const bus = createHookBus({ now: () => 4000, staleMs: 5000 });

    const events: HookEvent[] = [];
    const liveness: unknown[] = [];
    bus.onEvent((e) => events.push(e));
    bus.onLiveness((...args) => liveness.push(args));

    expect(() => bus.ingest({ hook_event_name: 'Notification' })).not.toThrow();
    expect(() => bus.ingest(42)).not.toThrow();
    expect(() => bus.ingest(null)).not.toThrow();

    expect(events).toHaveLength(0);
    expect(liveness).toHaveLength(0);
  });

  it('reports liveness as connected up to staleMs, then stale after', () => {
    const t0 = 10_000;
    const staleMs = 1000;
    const bus = createHookBus({ now: () => t0, staleMs });

    bus.ingest(notification());

    expect(bus.getLiveness(t0 + staleMs - 1).connected).toBe(true);
    expect(bus.getLiveness(t0 + staleMs).connected).toBe(false);
  });

  it('checkStale emits onLiveness(false, lastReceivedAt) once the window elapses', () => {
    const t0 = 20_000;
    const staleMs = 1000;
    const bus = createHookBus({ now: () => t0, staleMs });

    bus.ingest(notification());

    const liveness: Array<{ connected: boolean; lastReceivedAt: number | null }> = [];
    bus.onLiveness((connected, lastReceivedAt) => liveness.push({ connected, lastReceivedAt }));

    bus.checkStale(t0 + staleMs);

    expect(liveness).toEqual([{ connected: false, lastReceivedAt: t0 }]);
  });

  it('a throwing subscriber does not prevent other subscribers from being called', () => {
    const bus = createHookBus({ now: () => 5000, staleMs: 5000 });

    const events: HookEvent[] = [];
    bus.onEvent(() => {
      throw new Error('bad subscriber');
    });
    bus.onEvent((e) => events.push(e));

    const liveness: unknown[] = [];
    bus.onLiveness(() => {
      throw new Error('bad liveness subscriber');
    });
    bus.onLiveness((connected) => liveness.push(connected));

    expect(() => bus.ingest(notification())).not.toThrow();

    expect(events).toHaveLength(1);
    expect(liveness).toEqual([true]);
  });
});
