import { describe, expect, it } from 'vitest';

import { DEFAULT_LOOP_CAP, derivePipelineTimeline } from '@/lib/pipeline-timeline';
import type { BridgeState, RosterTimeline, SessionPersona } from '@/lib/ws-client';

const WORK_ITEM_ID = 'WI-9';

function standardRosterTimeline(): RosterTimeline {
  return Object.freeze({
    path: '/abs/repo',
    roles: Object.freeze([
      Object.freeze({
        role: 'builder',
        phases: Object.freeze([
          Object.freeze({ phase: 'planning', persona: 'Navigator' }),
          Object.freeze({ phase: 'coding', persona: 'Shipwright' }),
          Object.freeze({ phase: 'testing', persona: 'Lookout' }),
          Object.freeze({ phase: 'shipping', persona: 'Harbormaster' }),
        ]),
      }),
      Object.freeze({
        role: 'reviewer',
        phases: Object.freeze([Object.freeze({ phase: 'reviewing', persona: 'Warden' })]),
      }),
    ]),
  });
}

function persona(overrides: Partial<SessionPersona> = {}): SessionPersona {
  return Object.freeze({
    sessionId: 'sess-1',
    workItemId: WORK_ITEM_ID,
    role: 'builder',
    phase: null,
    persona: null,
    ...overrides,
  });
}

function bridgeState(overrides: Partial<BridgeState> = {}): BridgeState {
  return Object.freeze({
    path: '/abs/repo',
    stage: 'coding',
    gate: 'running',
    sessionId: 'sess-1',
    inbox: Object.freeze([]),
    reworkCount: 0,
    ...overrides,
  });
}

describe('derivePipelineTimeline', () => {
  it('orders stages: builder non-shipping phases, then reviewer phases, then builder shipping', () => {
    const model = derivePipelineTimeline(
      Object.freeze({
        rosterTimeline: standardRosterTimeline(),
        sessionPersonas: Object.freeze([]),
        workItemId: WORK_ITEM_ID,
        bridgeState: undefined,
      }),
    );

    expect(model.stages.map((stage) => stage.persona)).toEqual([
      'Navigator',
      'Shipwright',
      'Lookout',
      'Warden',
      'Harbormaster',
    ]);
    // Reviewing must land before shipping in the composed order.
    const reviewingIndex = model.stages.findIndex((stage) => stage.phase === 'reviewing');
    const shippingIndex = model.stages.findIndex((stage) => stage.phase === 'shipping');
    expect(reviewingIndex).toBeGreaterThan(-1);
    expect(shippingIndex).toBeGreaterThan(-1);
    expect(reviewingIndex).toBeLessThan(shippingIndex);
  });

  it('marks the stage matching the session persona in coding phase as current, and nothing else', () => {
    const model = derivePipelineTimeline(
      Object.freeze({
        rosterTimeline: standardRosterTimeline(),
        sessionPersonas: Object.freeze([
          persona({ role: 'builder', phase: 'coding', persona: 'Shipwright' }),
        ]),
        workItemId: WORK_ITEM_ID,
        bridgeState: undefined,
      }),
    );

    const currentStages = model.stages.filter((stage) => stage.current);
    expect(currentStages).toHaveLength(1);
    expect(currentStages[0]!.persona).toBe('Shipwright');
    expect(currentStages[0]!.phase).toBe('coding');
    expect(model.currentPersona).toBe('Shipwright');
    expect(model.currentPhase).toBe('coding');
  });

  it('derives loopNumber from bridgeState.reworkCount and loopCap from input (default DEFAULT_LOOP_CAP)', () => {
    const model = derivePipelineTimeline(
      Object.freeze({
        rosterTimeline: standardRosterTimeline(),
        sessionPersonas: Object.freeze([]),
        workItemId: WORK_ITEM_ID,
        bridgeState: bridgeState({ reworkCount: 2 }),
      }),
    );

    expect(model.loopNumber).toBe(2);
    expect(model.loopCap).toBe(3);
    expect(model.loopCap).toBe(DEFAULT_LOOP_CAP);
  });

  it('respects an explicit loopCap override', () => {
    const model = derivePipelineTimeline(
      Object.freeze({
        rosterTimeline: standardRosterTimeline(),
        sessionPersonas: Object.freeze([]),
        workItemId: WORK_ITEM_ID,
        bridgeState: undefined,
        loopCap: 5,
      }),
    );

    expect(model.loopCap).toBe(5);
  });

  it('returns empty stages and loopNumber 0 when the rosterTimeline is missing', () => {
    const model = derivePipelineTimeline(
      Object.freeze({
        rosterTimeline: undefined,
        sessionPersonas: Object.freeze([]),
        workItemId: WORK_ITEM_ID,
        bridgeState: undefined,
      }),
    );

    expect(model.stages).toEqual([]);
    expect(model.loopNumber).toBe(0);
    expect(model.currentPhase).toBeNull();
    expect(model.currentPersona).toBeNull();
  });

  it('does not mutate its inputs', () => {
    const rosterTimeline = standardRosterTimeline();
    const sessionPersonas = Object.freeze([
      persona({ role: 'builder', phase: 'coding', persona: 'Shipwright' }),
    ]);
    const state = bridgeState({ reworkCount: 1 });
    const input = Object.freeze({
      rosterTimeline,
      sessionPersonas,
      workItemId: WORK_ITEM_ID,
      bridgeState: state,
    });

    expect(() => derivePipelineTimeline(input)).not.toThrow();

    expect(rosterTimeline).toEqual(standardRosterTimeline());
    expect(sessionPersonas).toEqual([
      persona({ role: 'builder', phase: 'coding', persona: 'Shipwright' }),
    ]);
    expect(state).toEqual(bridgeState({ reworkCount: 1 }));
  });
});
