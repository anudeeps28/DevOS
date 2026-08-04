// Client-side lifecycle STAGE derivation.
//
// The whole-project stage (New→Decide→Define→Build→Ship) is composed on the CLIENT so
// it REUSES the per-card tracker-state read the grid already performs (ARCHITECTURE
// §9.2/§9.6). The server supplies only the extra signals the client can't derive
// (local files, story, feature-branch commits, release tags) via `LifecycleSignals`;
// the tracker-derived signals come from the card's already-fetched `TrackerState`.
//
// Stage = max(precedence) over the signals (§9.2). Because the highest present floor
// always wins, the badge never regresses while its durable signals persist — a sticky
// high-water mark with no stored value.

import type { LifecycleSignals, TrackerState } from '@/lib/ws-client';

/** The whole-project lifecycle stage (V1: 5 states; Learn folds into Ship). */
export type LifecycleStage = 'New' | 'Decide' | 'Define' | 'Build' | 'Ship';

const STAGE_PRECEDENCE: Readonly<Record<LifecycleStage, number>> = {
  New: 0,
  Decide: 1,
  Define: 2,
  Build: 3,
  Ship: 4,
};

/** Whether a tracker task looks like an open wayfinder:map decision item. */
function isWayfinderMap(id: string, title: string): boolean {
  const needle = 'wayfinder:map';
  return id.toLowerCase().includes(needle) || title.toLowerCase().includes(needle);
}

/**
 * Compose the lifecycle stage from the server signals plus the card's tracker state.
 * The tracker contributes: an open `wayfinder:map` item → Decide; any other open task
 * → Define ("decomposed but unstarted"). A single task is ONE or the OTHER, never both,
 * so a Decide-stage project is not outranked into Define. An unreachable tracker (or
 * one with no open task) contributes nothing — Build/Ship still derive from the server
 * signals, and Decide/Define may honestly under-read to the local floor (§9.2 fallback).
 */
export function resolveStage(
  signals: LifecycleSignals,
  tracker: TrackerState | undefined,
): LifecycleStage {
  const nextTask = tracker?.reachable ? tracker.nextTask : null;
  const trackerWayfinderMap = nextTask !== null && isWayfinderMap(nextTask.id, nextTask.title);
  const trackerDecomposedUnstarted = nextTask !== null && !trackerWayfinderMap;

  let stage: LifecycleStage = 'New';
  const bump = (candidate: LifecycleStage): void => {
    if (STAGE_PRECEDENCE[candidate] > STAGE_PRECEDENCE[stage]) stage = candidate;
  };

  if (signals.hasDecideDocs || trackerWayfinderMap) bump('Decide');
  if (signals.hasDefineDocs || trackerDecomposedUnstarted) bump('Define');
  if (signals.hasStartedStory || signals.hasFeatureBranchCommits) bump('Build');
  if (signals.hasReleaseTags) bump('Ship');

  return stage;
}

/** Display-only next-skill button state for a given lifecycle stage. */
export type NextStageAction = {
  readonly label: string;
  readonly active: boolean;
};

const NEXT_STAGE_ACTIONS: Readonly<Record<LifecycleStage, NextStageAction>> = {
  New: { label: '/grill-me', active: true },
  Decide: { label: '/architect', active: true },
  Define: { label: '/implement', active: true },
  Build: { label: '', active: false },
  Ship: { label: '/improve-harness', active: true },
};

/**
 * DISPLAY-ONLY next-skill label for the stage launcher button. The authoritative
 * stage→prompt map lives server-side in `server/src/session/stage-actions.ts` — this
 * mirror carries no wire authority and exists only to render the button's label/active
 * state. Build has no next-skill label, so the launcher goes quiet (`active: false`).
 */
export function nextStageAction(stage: LifecycleStage): NextStageAction {
  return NEXT_STAGE_ACTIONS[stage];
}
