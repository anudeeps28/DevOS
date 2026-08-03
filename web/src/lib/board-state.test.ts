import { describe, expect, it } from 'vitest';

import { deriveBoard } from '@/lib/board-state';
import type { BoardColumnId } from '@/lib/board-state';
import type { BridgeState, SessionPersona, TrackerState } from '@/lib/ws-client';

function persona(overrides: Partial<SessionPersona> = {}): SessionPersona {
  return {
    sessionId: 'sess-1',
    workItemId: 'wi-1',
    role: 'builder',
    phase: 'coding',
    persona: 'Shipwright',
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

function tracker(overrides: Partial<TrackerState> = {}): TrackerState {
  return {
    path: '/abs/repo',
    reachable: true,
    tracker: 'github',
    nextTask: null,
    ...overrides,
  };
}

function columnCards(model: ReturnType<typeof deriveBoard>, id: BoardColumnId) {
  return model.columns.find((column) => column.id === id)?.cards ?? [];
}

describe('deriveBoard — phase → column mapping', () => {
  const phases: readonly BoardColumnId[] = ['planning', 'coding', 'testing', 'reviewing', 'shipping'];

  for (const phase of phases) {
    it(`places a work item with phase '${phase}' in the '${phase}' column and no other`, () => {
      const model = deriveBoard({
        sessionPersonas: { '/abs/repo': [persona({ phase })] },
        bridgeStates: {},
        trackerStates: {},
      });

      const otherColumns: readonly BoardColumnId[] = [
        'queued',
        'planning',
        'coding',
        'testing',
        'reviewing',
        'shipping',
        'merged',
      ].filter((id): id is BoardColumnId => id !== phase) as readonly BoardColumnId[];

      expect(columnCards(model, phase).map((card) => card.workItemId)).toEqual(['wi-1']);
      for (const other of otherColumns) {
        expect(columnCards(model, other).map((card) => card.workItemId)).not.toContain('wi-1');
      }
    });
  }
});

describe('deriveBoard — loop-back', () => {
  it('a builder persona back in coding lands in coding, not testing', () => {
    const model = deriveBoard({
      sessionPersonas: {
        '/abs/repo': [
          persona({ role: 'builder', phase: 'coding' }),
          persona({ sessionId: 'sess-2', role: 'reviewer', phase: 'testing' }),
        ],
      },
      bridgeStates: {},
      trackerStates: {},
    });

    expect(columnCards(model, 'coding').map((card) => card.workItemId)).toContain('wi-1');
    expect(columnCards(model, 'testing').map((card) => card.workItemId)).not.toContain('wi-1');
  });
});

describe('deriveBoard — merged precedence', () => {
  it('a done bridge whose sessionId matches the item moves it to Merged, not shipping', () => {
    const model = deriveBoard({
      sessionPersonas: {
        '/abs/repo': [persona({ sessionId: 'sess-1', phase: 'shipping' })],
      },
      bridgeStates: {
        '/abs/repo': bridge({ gate: 'done', sessionId: 'sess-1' }),
      },
      trackerStates: {},
    });

    expect(columnCards(model, 'merged').map((card) => card.workItemId)).toEqual(['wi-1']);
    expect(columnCards(model, 'shipping').map((card) => card.workItemId)).not.toContain('wi-1');
  });

  it('a done bridge whose sessionId does not match the item stays in its phase column', () => {
    const model = deriveBoard({
      sessionPersonas: {
        '/abs/repo': [persona({ sessionId: 'sess-1', phase: 'shipping' })],
      },
      bridgeStates: {
        '/abs/repo': bridge({ gate: 'done', sessionId: 'sess-other' }),
      },
      trackerStates: {},
    });

    expect(columnCards(model, 'shipping').map((card) => card.workItemId)).toEqual(['wi-1']);
    expect(columnCards(model, 'merged').map((card) => card.workItemId)).not.toContain('wi-1');
  });
});

describe('deriveBoard — queued rule', () => {
  it('a next-task that is not an active work item appears in Queued', () => {
    const model = deriveBoard({
      sessionPersonas: {},
      bridgeStates: {},
      trackerStates: {
        '/abs/repo': tracker({ nextTask: { id: 'wi-2', title: 'Do the thing', priority: 1, url: null } }),
      },
    });

    expect(columnCards(model, 'queued').map((card) => card.workItemId)).toEqual(['wi-2']);
  });

  it('a next-task whose id is already an active work item does not produce a duplicate Queued card', () => {
    const model = deriveBoard({
      sessionPersonas: {
        '/abs/repo': [persona({ workItemId: 'wi-1', phase: 'coding' })],
      },
      bridgeStates: {},
      trackerStates: {
        '/abs/repo': tracker({ nextTask: { id: 'wi-1', title: 'Do the thing', priority: 1, url: null } }),
      },
    });

    expect(columnCards(model, 'queued').map((card) => card.workItemId)).not.toContain('wi-1');
    expect(columnCards(model, 'coding').map((card) => card.workItemId)).toEqual(['wi-1']);
  });
});

describe('deriveBoard — shape and immutability', () => {
  it('always returns exactly 7 columns in COLUMN_ORDER', () => {
    const model = deriveBoard({ sessionPersonas: {}, bridgeStates: {}, trackerStates: {} });

    expect(model.columns.map((column) => column.id)).toEqual([
      'queued',
      'planning',
      'coding',
      'testing',
      'reviewing',
      'shipping',
      'merged',
    ]);
  });

  it('the returned model and each column cards array are frozen', () => {
    const model = deriveBoard({
      sessionPersonas: { '/abs/repo': [persona({ phase: 'coding' })] },
      bridgeStates: {},
      trackerStates: {},
    });

    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.columns)).toBe(true);
    for (const column of model.columns) {
      expect(Object.isFrozen(column.cards)).toBe(true);
    }
  });
});
