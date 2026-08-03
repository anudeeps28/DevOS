import { describe, expect, it } from 'vitest';

import { deriveNeedsYou } from '@/lib/needs-you';
import type {
  BridgeState,
  ForeignNeedsYou,
  PermissionRequest,
} from '@/lib/ws-client';

function permission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    path: '/abs/repo',
    sessionId: 'sess-1',
    requestId: 'req-1',
    toolUseId: null,
    toolName: 'Bash',
    title: null,
    input: '{}',
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function bridge(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    path: '/abs/repo',
    stage: 'implement',
    gate: 'awaiting-approval',
    sessionId: 'sess-1',
    inbox: [],
    reworkCount: 0,
    ...overrides,
  };
}

function foreign(overrides: Partial<ForeignNeedsYou> = {}): ForeignNeedsYou {
  return {
    path: '/abs/repo',
    sessionId: 'sess-1',
    kind: 'idle_prompt',
    reason: '',
    ts: 1,
    cleared: false,
    ...overrides,
  };
}

describe('deriveNeedsYou', () => {
  it('returns [] for empty input', () => {
    expect(
      deriveNeedsYou({
        pendingPermissions: {},
        bridgeStates: {},
        foreignNeedsYou: [],
      }),
    ).toEqual([]);
  });

  it('merges across sources and projects, sorted ascending by waitSince (longest wait first)', () => {
    const input = {
      pendingPermissions: {
        'sess-1': [permission({ requestId: 'req-1', ts: 500 })],
      },
      bridgeStates: {
        '/abs/repoA': bridge({
          path: '/abs/repoA',
          inbox: [{ stage: 'implement', kind: 'question', reason: 'q', ts: 300 }],
        }),
        '/abs/repoB': bridge({
          path: '/abs/repoB',
          inbox: [{ stage: 'review', kind: 'escalation', reason: 'e', ts: 700 }],
        }),
      },
      foreignNeedsYou: [foreign({ sessionId: 'sess-2', ts: 100 })],
    };

    const result = deriveNeedsYou(input);

    expect(result).toHaveLength(4);
    expect(result.map((i) => i.waitSince)).toEqual([100, 300, 500, 700]);
    expect(result.map((i) => i.source)).toEqual(['foreign', 'bridge', 'permission', 'bridge']);
    expect(result.map((i) => i.key)).toEqual([
      'foreign::sess-2',
      'bridge::/abs/repoA::implement::300',
      'permission::req-1',
      'bridge::/abs/repoB::review::700',
    ]);
  });

  it('tie-breaks equal waitSince by key ascending', () => {
    const input = {
      pendingPermissions: {
        'sess-1': [permission({ requestId: 'zzz', ts: 42 })],
      },
      bridgeStates: {},
      foreignNeedsYou: [foreign({ sessionId: 'aaa', ts: 42 })],
    };

    const result = deriveNeedsYou(input);

    expect(result.map((i) => i.key)).toEqual(['foreign::aaa', 'permission::zzz']);
  });

  it('does not mutate inputs and returns a new array reference', () => {
    const inputPermissions = { 'sess-1': [permission()] };
    const inputBridgeStates = { '/abs/repo': bridge({ inbox: [{ stage: 's', kind: 'interrupt', reason: 'r', ts: 1 }] }) };
    const inputForeign = [foreign()];
    const input = {
      pendingPermissions: inputPermissions,
      bridgeStates: inputBridgeStates,
      foreignNeedsYou: inputForeign,
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    const result = deriveNeedsYou(input);

    expect(input).toEqual(snapshot);
    expect(result).not.toBe(inputForeign);
  });

  it('excludes cleared foreign entries', () => {
    const input = {
      pendingPermissions: {},
      bridgeStates: {},
      foreignNeedsYou: [
        foreign({ sessionId: 'sess-1', ts: 10, cleared: true }),
        foreign({ sessionId: 'sess-2', ts: 20, cleared: false }),
      ],
    };

    const result = deriveNeedsYou(input);

    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('foreign::sess-2');
  });
});
