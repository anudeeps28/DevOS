import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHeartbeat } from '@/hooks/useHeartbeat';
import type {
  ConnectionStatus,
  Heartbeat,
  HeartbeatListener,
  StatusListener,
  WsClient,
} from '@/lib/ws-client';

/**
 * A fake WsClient that lets the test drive status + heartbeat emissions and
 * asserts teardown. Mirrors the real client: onStatus syncs immediately.
 */
function makeFakeClient() {
  let statusListener: StatusListener | null = null;
  let heartbeatListener: HeartbeatListener | null = null;
  let status: ConnectionStatus = 'connecting';
  const close = vi.fn();

  const client: WsClient = {
    getStatus: () => status,
    onStatus: (listener) => {
      statusListener = listener;
      listener(status);
      return () => {
        statusListener = null;
      };
    },
    onHeartbeat: (listener) => {
      heartbeatListener = listener;
      return () => {
        heartbeatListener = null;
      };
    },
    onRegistry: () => () => {},
    onCandidates: () => () => {},
    onGitState: () => () => {},
    onSkills: () => () => {},
    onTrackerState: () => () => {},
    onLifecycleSignals: () => () => {},
    onSessionState: () => () => {},
    onSessionPersonas: () => () => {},
    onWorkItemSessions: () => () => {},
    onSessionTranscript: () => () => {},
    onBridgeState: () => () => {},
    onPermissionRequest: () => () => {},
    onForeignNeedsYou: () => () => {},
    onHookBusLiveness: () => () => {},
    onCostUsage: () => () => {},
    pin: () => {},
    unpin: () => {},
    discover: () => {},
    requestGitState: () => {},
    requestSkills: () => {},
    requestTrackerState: () => {},
    requestLifecycleSignals: () => {},
    requestSessionPersonas: () => {},
    requestWorkItemSessions: () => {},
    spawnSession: () => {},
    requestTranscript: () => {},
    sendSessionInput: () => {},
    interruptSession: () => {},
    sendBridgeStart: () => {},
    sendGateApprove: () => {},
    sendBridgeInterrupt: () => {},
    sendPermissionDecision: () => {},
    close,
  };

  return {
    client,
    close,
    emitStatus: (next: ConnectionStatus) => {
      status = next;
      statusListener?.(next);
    },
    emitHeartbeat: (hb: Heartbeat) => heartbeatListener?.(hb),
  };
}

describe('useHeartbeat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the initial status and no heartbeat before the first beat', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useHeartbeat({ createClient: () => fake.client }),
    );

    expect(result.current.status).toBe('connecting');
    expect(result.current.heartbeat).toBeNull();
  });

  it('updates status and latest heartbeat as the client emits', () => {
    const fake = makeFakeClient();
    const { result } = renderHook(() =>
      useHeartbeat({ createClient: () => fake.client }),
    );

    act(() => fake.emitStatus('connected'));
    expect(result.current.status).toBe('connected');

    act(() => fake.emitHeartbeat({ seq: 1, ts: 1000 }));
    expect(result.current.heartbeat).toEqual({ seq: 1, ts: 1000 });

    // Latest wins — prior heartbeat is replaced, not merged.
    act(() => fake.emitHeartbeat({ seq: 2, ts: 2000 }));
    expect(result.current.heartbeat).toEqual({ seq: 2, ts: 2000 });
  });

  it('closes the client on unmount', () => {
    const fake = makeFakeClient();
    const { unmount } = renderHook(() =>
      useHeartbeat({ createClient: () => fake.client }),
    );

    expect(fake.close).not.toHaveBeenCalled();
    unmount();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
