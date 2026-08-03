// Pure client-side derivation of the pipeline-timeline view — no React, no I/O.
// Composes a work item's ordered stage list (SPEC §6 display order) plus the
// currently active stage from the roster timeline and session personas.
// Everything here is a pure function over its inputs; nothing is mutated.

import type { BridgeState, RosterTimeline, SessionPersona } from '@/lib/ws-client';

/** Default cap on rework loops before escalation, per SPEC §6. */
export const DEFAULT_LOOP_CAP = 3;

/** One stage in the composed pipeline timeline, with its current-stage flag. */
export interface TimelineStage {
  readonly phase: string;
  readonly persona: string;
  readonly current: boolean;
}

/** The full derived pipeline-timeline model for one work item. */
export interface PipelineTimelineModel {
  readonly stages: readonly TimelineStage[];
  readonly currentPhase: string | null;
  readonly currentPersona: string | null;
  readonly loopNumber: number;
  readonly loopCap: number;
}

/**
 * The phase id moved to the end of the composed stage order. This is a stable
 * phase *id* from the five-id contract in `.claude/rules/phase-markers.md`
 * (planning/coding/testing/reviewing/shipping) — NOT a persona display string —
 * so ordering never duplicates roster display text (persona-is-roster-data).
 */
const SHIPPING_PHASE = 'shipping';

/**
 * Compose the ordered stage list per SPEC §6 display order (…Test→Review→PR):
 * the builder role's phases except `shipping`, then the reviewer role's phases,
 * then the builder's `shipping` phase(s) — so `reviewing` (Warden) precedes
 * `shipping` (Harbormaster). Ordering keys strictly on the stable phase ids of
 * `rules/phase-markers.md`; display text always comes from the frame's persona.
 * Builder = first pipeline role in rosterTimeline.roles, reviewer = second. If
 * either is absent, fall back to concatenating all roles' phases in order.
 */
function composeStageOrder(
  rosterTimeline: RosterTimeline | undefined,
): readonly { readonly phase: string; readonly persona: string }[] {
  const roles = rosterTimeline?.roles ?? [];
  const builder = roles[0];
  const reviewer = roles[1];

  if (builder === undefined || reviewer === undefined) {
    return roles.flatMap((role) => role.phases);
  }

  const builderNonShipping = builder.phases.filter((stage) => stage.phase !== SHIPPING_PHASE);
  const builderShipping = builder.phases.filter((stage) => stage.phase === SHIPPING_PHASE);

  return [...builderNonShipping, ...reviewer.phases, ...builderShipping];
}

/**
 * Find the current phase id for this work item from sessionPersonas: prefer
 * a builder-role entry with a non-null `phase`; fall back to any non-null
 * phase for the item.
 */
export function findCurrentPhase(
  sessionPersonas: readonly SessionPersona[],
  workItemId: string,
): string | null {
  const forItem = sessionPersonas.filter((persona) => persona.workItemId === workItemId);

  const builderEntry = forItem.find((persona) => persona.role === 'builder' && persona.phase !== null);
  if (builderEntry !== undefined) return builderEntry.phase;

  const anyEntry = forItem.find((persona) => persona.phase !== null);
  return anyEntry?.phase ?? null;
}

/**
 * Derive the pipeline-timeline model: the ordered stage list with the
 * current stage flagged, plus loop bookkeeping from the bridge state.
 * Pure + immutable — returns new, frozen objects/arrays.
 */
export function derivePipelineTimeline(input: {
  readonly rosterTimeline: RosterTimeline | undefined;
  readonly sessionPersonas: readonly SessionPersona[];
  readonly workItemId: string;
  readonly bridgeState: BridgeState | undefined;
  readonly loopCap?: number;
}): PipelineTimelineModel {
  const orderedStages = composeStageOrder(input.rosterTimeline);
  const currentPhase = findCurrentPhase(input.sessionPersonas, input.workItemId);

  const stages: TimelineStage[] = orderedStages.map((stage) => ({
    phase: stage.phase,
    persona: stage.persona,
    current: currentPhase !== null && stage.phase === currentPhase,
  }));

  const currentStage = stages.find((stage) => stage.current);

  return Object.freeze({
    stages: Object.freeze(stages),
    currentPhase,
    currentPersona: currentStage?.persona ?? null,
    loopNumber: input.bridgeState?.reworkCount ?? 0,
    loopCap: input.loopCap ?? DEFAULT_LOOP_CAP,
  });
}
