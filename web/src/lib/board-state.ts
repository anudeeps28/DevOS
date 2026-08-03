// Pure client-side derivation of the board view — no React, no I/O. Places
// each work item into a single kanban column derived from its bridge state
// and current pipeline phase, plus a scoped Queued column sourced from each
// project's tracker next-task. Everything here is a pure function over its
// inputs; nothing is mutated.

import type { BridgeState, SessionPersona, TrackerState } from '@/lib/ws-client';
import { findCurrentPhase } from '@/lib/pipeline-timeline';

/** The seven kanban columns a work item card can land in. */
export type BoardColumnId =
  | 'queued'
  | 'planning'
  | 'coding'
  | 'testing'
  | 'reviewing'
  | 'shipping'
  | 'merged';

/** One work item's board card. */
export interface WorkItemCard {
  readonly workItemId: string;
  readonly projectPath: string;
  readonly columnId: BoardColumnId;
  readonly phase: string | null;
  readonly persona: string | null;
  readonly title: string;
}

/** One board column with its ordered cards. */
export interface BoardColumn {
  readonly id: BoardColumnId;
  readonly label: string;
  readonly cards: readonly WorkItemCard[];
}

/** The full derived board model: all seven columns, in display order. */
export interface BoardModel {
  readonly columns: readonly BoardColumn[];
}

/** Column ids + labels, in the fixed display order. */
const COLUMN_ORDER: readonly { readonly id: BoardColumnId; readonly label: string }[] = [
  { id: 'queued', label: 'Queued' },
  { id: 'planning', label: 'Planning' },
  { id: 'coding', label: 'Coding' },
  { id: 'testing', label: 'Testing' },
  { id: 'reviewing', label: 'Review' },
  { id: 'shipping', label: 'PR' },
  { id: 'merged', label: 'Merged' },
];

/**
 * Stable phase id (per `.claude/rules/phase-markers.md`) → board column id.
 * Keys are phase ids, never persona display strings.
 */
const PHASE_TO_COLUMN: Record<string, BoardColumnId> = {
  planning: 'planning',
  coding: 'coding',
  testing: 'testing',
  reviewing: 'reviewing',
  shipping: 'shipping',
};

/**
 * Pick the persona string findCurrentPhase would associate with this work
 * item: prefer a builder-role entry with a non-null phase, else any entry
 * with a non-null phase.
 */
function pickPersona(forItem: readonly SessionPersona[]): string | null {
  const builderEntry = forItem.find((persona) => persona.role === 'builder' && persona.phase !== null);
  if (builderEntry !== undefined) return builderEntry.persona ?? null;

  const anyEntry = forItem.find((persona) => persona.phase !== null);
  return anyEntry?.persona ?? null;
}

/**
 * Derive the board model from the raw useProjects() slices: place each
 * active work item into its bridge/phase-derived column, then add Queued
 * cards for each project's tracker next-task that isn't already active.
 * Pure + immutable — returns new, frozen objects/arrays.
 */
export function deriveBoard(input: {
  readonly sessionPersonas: Record<string, readonly SessionPersona[]>;
  readonly bridgeStates: Record<string, BridgeState>;
  readonly trackerStates: Record<string, TrackerState>;
}): BoardModel {
  const activeWorkItemIds = new Set<string>();
  const cards: WorkItemCard[] = [];

  for (const [path, personas] of Object.entries(input.sessionPersonas)) {
    const workItemIds = new Set<string>();
    for (const persona of personas) {
      if (persona.workItemId !== null) workItemIds.add(persona.workItemId);
    }

    const bridgeState = input.bridgeStates[path];

    for (const workItemId of workItemIds) {
      activeWorkItemIds.add(workItemId);

      const forItem = personas.filter((persona) => persona.workItemId === workItemId);
      const currentPhase = findCurrentPhase(personas, workItemId);

      const isMerged =
        bridgeState !== undefined &&
        bridgeState.gate === 'done' &&
        forItem.some((persona) => persona.sessionId === bridgeState.sessionId);

      let columnId: BoardColumnId | undefined;
      if (isMerged) {
        columnId = 'merged';
      } else if (currentPhase !== null) {
        columnId = PHASE_TO_COLUMN[currentPhase];
      }

      if (columnId === undefined) continue;

      cards.push(
        Object.freeze({
          workItemId,
          projectPath: path,
          columnId,
          phase: currentPhase,
          persona: pickPersona(forItem),
          title: workItemId,
        }),
      );
    }
  }

  for (const [path, trackerState] of Object.entries(input.trackerStates)) {
    const nextTask = trackerState.nextTask;
    if (nextTask === null || activeWorkItemIds.has(nextTask.id)) continue;

    cards.push(
      Object.freeze({
        workItemId: nextTask.id,
        projectPath: path,
        columnId: 'queued',
        phase: null,
        persona: null,
        title: nextTask.title,
      }),
    );
  }

  const sortedCards = [...cards].sort(
    (a, b) => a.workItemId.localeCompare(b.workItemId) || a.projectPath.localeCompare(b.projectPath),
  );

  const columns: BoardColumn[] = COLUMN_ORDER.map(({ id, label }) =>
    Object.freeze({
      id,
      label,
      cards: Object.freeze(sortedCards.filter((card) => card.columnId === id)),
    }),
  );

  return Object.freeze({ columns: Object.freeze(columns) });
}
