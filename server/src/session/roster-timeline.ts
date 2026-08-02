// Roster-timeline builder — maps a project's role roster (harness-roles.json)
// into an ordered, display-ready timeline so the client never invents persona
// display labels; every persona string comes straight from the roster's own
// `phases[].displayName` (see roster-reader.ts).

import type { Roster } from './roster-reader.js';

/** A single display stage within a role's timeline — one roster phase. */
export interface RosterTimelineStage {
  readonly phase: string;
  readonly persona: string;
}

/** One pipeline role's ordered stages, in roster phase order. */
export interface RosterTimelineRole {
  readonly role: string;
  readonly phases: readonly RosterTimelineStage[];
}

/**
 * Build the roster-ordered timeline: one entry per `roster.pipeline` role, in
 * pipeline order, each carrying its `roles.<role>.phases` mapped to
 * `{ phase: id, persona: displayName }`. Pure — never throws. Returns `[]`
 * when `roster` is null (missing/malformed roster is drop-don't-throw upstream
 * in readRoster; this function just has nothing to build from).
 */
export function buildRosterTimeline(roster: Roster | null): readonly RosterTimelineRole[] {
  if (roster === null) return Object.freeze([]);

  const timeline: RosterTimelineRole[] = [];
  for (const role of roster.pipeline) {
    const def = roster.roles[role];
    const phases = def
      ? def.phases.map((p) => Object.freeze<RosterTimelineStage>({ phase: p.id, persona: p.displayName }))
      : [];
    timeline.push(Object.freeze<RosterTimelineRole>({ role, phases: Object.freeze(phases) }));
  }
  return Object.freeze(timeline);
}
