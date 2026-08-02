import { describe, expect, it } from 'vitest';

import { buildRosterTimeline } from './roster-timeline.js';
import type { Roster, RoleDef } from './roster-reader.js';
import type { Role } from './roles.js';

const ROLE_DEF = (displayName: string, phases: RoleDef['phases']): RoleDef =>
  Object.freeze({
    displayName,
    phases,
    skills: [],
    agent: displayName,
    model: 'claude-opus-5[1m]',
    effort: 'medium',
    producesArtifacts: [],
  });

const ROSTER: Roster = Object.freeze({
  schemaVersion: 2,
  pipeline: Object.freeze(['builder', 'reviewer'] as const) as readonly Role[],
  roles: Object.freeze({
    builder: ROLE_DEF('Builder', [
      { id: 'planning', displayName: 'Navigator' },
      { id: 'coding', displayName: 'Shipwright' },
      { id: 'testing', displayName: 'Lookout' },
      { id: 'shipping', displayName: 'Harbormaster' },
    ]),
    reviewer: ROLE_DEF('Reviewer', [{ id: 'reviewing', displayName: 'Warden' }]),
  }),
} as Roster);

describe('buildRosterTimeline', () => {
  it('returns [] for a null roster', () => {
    expect(buildRosterTimeline(null)).toEqual([]);
  });

  it('maps roster.pipeline, in order, to { role, phases: [{phase, persona}] }', () => {
    const timeline = buildRosterTimeline(ROSTER);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.role).toBe('builder');
    expect(timeline[1]?.role).toBe('reviewer');

    const builder = timeline[0];
    expect(builder?.phases).toHaveLength(4);
    expect(builder?.phases).toContainEqual({ phase: 'coding', persona: 'Shipwright' });
    expect(builder?.phases).toEqual([
      { phase: 'planning', persona: 'Navigator' },
      { phase: 'coding', persona: 'Shipwright' },
      { phase: 'testing', persona: 'Lookout' },
      { phase: 'shipping', persona: 'Harbormaster' },
    ]);

    const reviewer = timeline[1];
    expect(reviewer?.phases).toEqual([{ phase: 'reviewing', persona: 'Warden' }]);
  });

  it('freezes the returned timeline, each role entry, its phases array, and each stage', () => {
    const timeline = buildRosterTimeline(ROSTER);

    expect(Object.isFrozen(timeline)).toBe(true);
    for (const role of timeline) {
      expect(Object.isFrozen(role)).toBe(true);
      expect(Object.isFrozen(role.phases)).toBe(true);
      for (const stage of role.phases) {
        expect(Object.isFrozen(stage)).toBe(true);
      }
    }
  });

  it('freezes the [] returned for a null roster', () => {
    expect(Object.isFrozen(buildRosterTimeline(null))).toBe(true);
  });
});
