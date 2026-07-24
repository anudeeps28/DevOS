// QUARANTINED tracker normalization seam — the ONE module with tracker-specific
// logic in the whole tracker read path.
//
// `readTrackerState` (tracker-reader.ts) shells out to each project's OWN
// `.claude/trackers/active/get-sprint-issues.sh` adapter and hands the raw stdout
// here, keyed off the project's manifest `tracker` field. Everything backend-aware
// lives in THIS file; the reader, the WS protocol, the gateway, and the UI stay
// tracker-agnostic.
//
// FUTURE CONTRACT: once the harness ships a normalized `next-task` op (a
// tracker-agnostic adapter output), this function is the ONLY thing that changes —
// swap the per-backend parsing below for the normalized contract and the
// reader/WS/UI layers stay untouched. Keep this module small and replaceable.
//
// Boundary discipline: guarded JSON.parse, validate every field, NEVER throw.

import type { TrackerTask } from '../ws-protocol.js';

/** A single raw Todoist task as emitted by the adapter's `td task list --json`. */
interface RawTodoistTask {
  readonly id?: unknown;
  readonly content?: unknown;
  readonly priority?: unknown;
  readonly url?: unknown;
  readonly isUncompletable?: unknown;
}

/**
 * Whether a raw Todoist entry is a milestone / uncompletable parent item that
 * should never be surfaced as the "next task" (milestones are containers, not work).
 */
function isMilestone(task: RawTodoistTask): boolean {
  return task.isUncompletable === true;
}

/**
 * A task's identity as a usable {id, title} pair, or null if either is missing.
 * `id` may be a string or number (Todoist ids arrive as strings, but a numeric id
 * is coerced); `content` must be a non-empty string. A task lacking a real id or
 * title is NOT a valid candidate — we reject it rather than coerce it into the
 * `{id:"undefined", title:"undefined"}` placeholder that `String(undefined)` yields.
 */
function taskIdentity(task: RawTodoistTask): { id: string; title: string } | null {
  const id =
    typeof task.id === 'string' && task.id.length > 0
      ? task.id
      : typeof task.id === 'number' && Number.isFinite(task.id)
        ? String(task.id)
        : null;
  const title = typeof task.content === 'string' && task.content.length > 0 ? task.content : null;
  if (id === null || title === null) return null;
  return { id, title };
}

/**
 * Map a raw Todoist task (with an already-validated identity) to the frozen wire
 * shape. Remaining fields are validated at the boundary: a non-number priority
 * collapses to null, a non-string url to null.
 */
function toTrackerTask(task: RawTodoistTask, identity: { id: string; title: string }): TrackerTask {
  return Object.freeze<TrackerTask>({
    id: identity.id,
    title: identity.title,
    priority: typeof task.priority === 'number' ? task.priority : null,
    url: typeof task.url === 'string' ? task.url : null,
  });
}

/**
 * Pick the top open Todoist item from the raw array and map it to a TrackerTask.
 * Todoist priority is 4 = p1 (highest) … 1 = p4 (lowest); the highest numeric
 * priority wins, ties resolve to the first item in list order. Milestone /
 * uncompletable entries are excluded. Returns null for an empty candidate set.
 */
function normalizeTodoist(entries: readonly unknown[]): TrackerTask | null {
  let best: { task: RawTodoistTask; identity: { id: string; title: string } } | null = null;
  let bestPriority = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const task = entry as RawTodoistTask;
    if (isMilestone(task)) continue;

    // A task without a real id + title is not a valid candidate (drop it rather
    // than surfacing an "undefined" placeholder as the next task).
    const identity = taskIdentity(task);
    if (identity === null) continue;

    // Absent/non-number priority sorts below any real priority but still qualifies
    // as a candidate, so a list with no priorities still yields its first item.
    const priority = typeof task.priority === 'number' ? task.priority : 0;
    if (best === null || priority > bestPriority) {
      best = { task, identity };
      bestPriority = priority;
    }
  }

  return best === null ? null : toTrackerTask(best.task, best.identity);
}

/**
 * Normalize an adapter's raw stdout into the top open TrackerTask, or null.
 *
 * - Guarded JSON.parse; any parse failure or non-array payload → null.
 * - `tracker === 'todoist'`: parse the Todoist task array (see `normalizeTodoist`).
 * - Any other/unknown tracker → null (unsupported until a normalized op ships).
 *
 * Never throws.
 */
export function normalizeNextTask(tracker: string, stdout: string): TrackerTask | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  if (tracker === 'todoist') {
    return normalizeTodoist(parsed);
  }

  return null;
}
