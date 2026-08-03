import { describe, expect, it } from 'vitest';

import {
  deriveDerivedState,
  deriveFleet,
  SUBAGENT_TOOL_NAME,
} from '@/lib/fleet-state';
import type {
  BridgeState,
  ForeignNeedsYou,
  PermissionRequest,
  SessionPersona,
  SessionState,
  TranscriptEvent,
} from '@/lib/ws-client';

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 'sess-1',
    projectPath: '/abs/repo',
    role: 'builder',
    status: 'running',
    sdkSessionId: null,
    workItemId: 'wi-1',
    rateLimited: false,
    ...overrides,
  };
}

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

function bridge(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    path: '/abs/repo',
    stage: 'implement',
    gate: 'running',
    sessionId: 'sess-1',
    inbox: [],
    reworkCount: 0,
    ...overrides,
  };
}

const emptyContext = {
  pendingPermissions: {},
  foreignNeedsYou: [] as readonly ForeignNeedsYou[],
  bridgeState: undefined,
};

describe('deriveDerivedState — precedence', () => {
  it('rateLimited wins over everything else', () => {
    const s = session({ rateLimited: true, status: 'running' });
    expect(
      deriveDerivedState(s, {
        pendingPermissions: { 'sess-1': [permission()] },
        foreignNeedsYou: [],
        bridgeState: undefined,
      }),
    ).toBe('waiting-on-rate-limit');
  });

  it('a pending permission request → blocked', () => {
    const s = session();
    expect(
      deriveDerivedState(s, {
        pendingPermissions: { 'sess-1': [permission()] },
        foreignNeedsYou: [],
        bridgeState: undefined,
      }),
    ).toBe('blocked');
  });

  it('bridge gate awaiting-approval for this session → blocked', () => {
    const s = session();
    expect(
      deriveDerivedState(s, {
        pendingPermissions: {},
        foreignNeedsYou: [],
        bridgeState: bridge({ gate: 'awaiting-approval' }),
      }),
    ).toBe('blocked');
  });

  it('bridge gate escalated for this session → blocked', () => {
    const s = session();
    expect(
      deriveDerivedState(s, {
        pendingPermissions: {},
        foreignNeedsYou: [],
        bridgeState: bridge({ gate: 'escalated' }),
      }),
    ).toBe('blocked');
  });

  it('a foreign permission_prompt for this session → blocked', () => {
    const s = session();
    expect(
      deriveDerivedState(s, {
        pendingPermissions: {},
        foreignNeedsYou: [foreign({ kind: 'permission_prompt' })],
        bridgeState: undefined,
      }),
    ).toBe('blocked');
  });

  it('a foreign agent_needs_input for this session → blocked', () => {
    const s = session();
    expect(
      deriveDerivedState(s, {
        pendingPermissions: {},
        foreignNeedsYou: [foreign({ kind: 'agent_needs_input' })],
        bridgeState: undefined,
      }),
    ).toBe('blocked');
  });

  it('blocked outranks idle when both signals are present', () => {
    const s = session();
    expect(
      deriveDerivedState(s, {
        pendingPermissions: { 'sess-1': [permission()] },
        foreignNeedsYou: [foreign({ kind: 'idle_prompt' })],
        bridgeState: undefined,
      }),
    ).toBe('blocked');
  });

  it('a foreign idle_prompt for this session → idle', () => {
    const s = session({ status: 'running' });
    expect(
      deriveDerivedState(s, {
        pendingPermissions: {},
        foreignNeedsYou: [foreign({ kind: 'idle_prompt' })],
        bridgeState: undefined,
      }),
    ).toBe('idle');
  });

  it('idle outranks a running status when idle signal present', () => {
    const s = session({ status: 'running' });
    expect(
      deriveDerivedState(s, {
        pendingPermissions: {},
        foreignNeedsYou: [foreign({ kind: 'idle_prompt' })],
        bridgeState: undefined,
      }),
    ).toBe('idle');
  });

  it('a cleared foreign entry is ignored', () => {
    const s = session({ status: 'running' });
    expect(
      deriveDerivedState(s, {
        pendingPermissions: {},
        foreignNeedsYou: [foreign({ kind: 'permission_prompt', cleared: true })],
        bridgeState: undefined,
      }),
    ).toBe('running');
  });

  it('status running with no other signal → running', () => {
    expect(deriveDerivedState(session({ status: 'running' }), emptyContext)).toBe('running');
  });

  it('status ended maps straight through', () => {
    expect(deriveDerivedState(session({ status: 'ended' }), emptyContext)).toBe('ended');
  });

  it('status errored maps straight through', () => {
    expect(deriveDerivedState(session({ status: 'errored' }), emptyContext)).toBe('errored');
  });

  it('an unrecognized raw status with no other signal falls to idle', () => {
    expect(deriveDerivedState(session({ status: 'spawning' }), emptyContext)).toBe('idle');
  });
});

describe('deriveFleet — grouping', () => {
  it('groups sessions by workItemId', () => {
    const sessions = {
      '/abs/repo': [
        session({ id: 's1', workItemId: 'wi-1' }),
        session({ id: 's2', workItemId: 'wi-2', role: 'reviewer' }),
      ],
    };
    const lanes = deriveFleet({
      sessions,
      sessionPersonas: {},
      transcripts: {},
      pendingPermissions: {},
      foreignNeedsYou: [],
      bridgeStates: {},
    });

    expect(lanes.map((l) => l.workItemId)).toEqual(['wi-1', 'wi-2']);
    expect(lanes[0]?.sessions).toHaveLength(1);
    expect(lanes[0]?.sessions[0]?.sessionId).toBe('s1');
  });

  it('groups sessions with no workItemId under (unassigned)', () => {
    const sessions = {
      '/abs/repo': [session({ id: 's1', workItemId: null })],
    };
    const lanes = deriveFleet({
      sessions,
      sessionPersonas: {},
      transcripts: {},
      pendingPermissions: {},
      foreignNeedsYou: [],
      bridgeStates: {},
    });

    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.workItemId).toBe('(unassigned)');
  });

  it('orders lanes by workItemId, sessions within a lane by role', () => {
    const sessions = {
      '/abs/repo': [
        session({ id: 's1', workItemId: 'wi-2' }),
        session({ id: 's2', workItemId: 'wi-1', role: 'reviewer' }),
        session({ id: 's3', workItemId: 'wi-1', role: 'builder' }),
      ],
    };
    const lanes = deriveFleet({
      sessions,
      sessionPersonas: {},
      transcripts: {},
      pendingPermissions: {},
      foreignNeedsYou: [],
      bridgeStates: {},
    });

    expect(lanes.map((l) => l.workItemId)).toEqual(['wi-1', 'wi-2']);
    expect(lanes[0]?.sessions.map((s) => s.role)).toEqual(['builder', 'reviewer']);
  });

  it('keeps sessions from different projects that share a work-item key in separate lanes', () => {
    // Two pinned projects each with an unassigned session must NOT collapse into one
    // lane — each lane keeps its own projectPath (regression: grouping by workItemId alone).
    const sessions = {
      '/abs/repoA': [session({ id: 'a1', workItemId: null })],
      '/abs/repoB': [session({ id: 'b1', workItemId: null })],
    };
    const lanes = deriveFleet({
      sessions,
      sessionPersonas: {},
      transcripts: {},
      pendingPermissions: {},
      foreignNeedsYou: [],
      bridgeStates: {},
    });

    expect(lanes).toHaveLength(2);
    expect(lanes.every((l) => l.workItemId === '(unassigned)')).toBe(true);
    expect(lanes.map((l) => l.projectPath).sort()).toEqual(['/abs/repoA', '/abs/repoB']);
    expect(lanes.flatMap((l) => l.sessions.map((s) => s.sessionId)).sort()).toEqual(['a1', 'b1']);
  });

  it('joins persona by sessionId from the sessionPersonas map', () => {
    const sessions = { '/abs/repo': [session({ id: 's1' })] };
    const personas: Record<string, readonly SessionPersona[]> = {
      '/abs/repo': [
        { sessionId: 's1', workItemId: 'wi-1', role: 'builder', phase: 'coding', persona: 'Shipwright' },
      ],
    };
    const lanes = deriveFleet({
      sessions,
      sessionPersonas: personas,
      transcripts: {},
      pendingPermissions: {},
      foreignNeedsYou: [],
      bridgeStates: {},
    });

    expect(lanes[0]?.sessions[0]?.persona).toBe('Shipwright');
  });
});

describe('deriveFleet — subagent extraction', () => {
  function toolUseEvent(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
    return {
      kind: 'tool-use',
      toolName: SUBAGENT_TOOL_NAME,
      toolInput: 'run the story-executor-agent',
      toolUseId: 'tu-1',
      sessionId: 's1',
      seq: 1,
      ts: 1,
      ...overrides,
    } as TranscriptEvent;
  }

  it('extracts subagent lanes from Task tool-use events', () => {
    const sessions = { '/abs/repo': [session({ id: 's1' })] };
    const transcripts = { s1: [toolUseEvent()] };
    const lanes = deriveFleet({
      sessions,
      sessionPersonas: {},
      transcripts,
      pendingPermissions: {},
      foreignNeedsYou: [],
      bridgeStates: {},
    });

    expect(lanes[0]?.sessions[0]?.subagents).toEqual([
      { id: 'tu-1', label: 'run the story-executor-agent' },
    ]);
  });

  it('ignores non-Task tool-use events and other event kinds', () => {
    const sessions = { '/abs/repo': [session({ id: 's1' })] };
    const transcripts: Record<string, readonly TranscriptEvent[]> = {
      s1: [
        toolUseEvent({ toolName: 'Bash', toolUseId: 'tu-2' }),
        { kind: 'assistant-text', text: 'hi', sessionId: 's1', seq: 2, ts: 2 },
      ],
    };
    const lanes = deriveFleet({
      sessions,
      sessionPersonas: {},
      transcripts,
      pendingPermissions: {},
      foreignNeedsYou: [],
      bridgeStates: {},
    });

    expect(lanes[0]?.sessions[0]?.subagents).toEqual([]);
  });

  it('a session with no transcript still gets an (empty) subagents array — never flattened away', () => {
    const sessions = { '/abs/repo': [session({ id: 's1' })] };
    const lanes = deriveFleet({
      sessions,
      sessionPersonas: {},
      transcripts: {},
      pendingPermissions: {},
      foreignNeedsYou: [],
      bridgeStates: {},
    });

    expect(lanes[0]?.sessions[0]?.subagents).toEqual([]);
  });
});
