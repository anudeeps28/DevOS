// Best-effort story-state reader for a project.
//
// Mirrors the "drop, don't throw / frozen-return / hard-caps" template of the
// git/tracker readers. Derives the ONE lifecycle-relevant fact this task needs:
// whether any `tasks/stories/<id>/` work item is genuinely STARTED (the Build
// floor, per ARCHITECTURE §9.2). The one place strictness matters (§9.2): an
// empty story folder — or one holding only a scaffold `brief.md` — must NOT count
// as started; only an `executor-state.md` with a real Progress section does.
//
//  - Drop, don't throw: a missing `tasks/stories` dir, an unreadable entry, or any
//    other failure yields `{ hasStartedStory: false }` — readStoryStates NEVER
//    throws and NEVER rejects.
//  - Immutable: the return is a fresh Object.freeze(...)'d summary.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// Cap on how much of an executor-state.md we read before giving up — a well-formed
// file is a few KiB; the cap defends against a pathological file.
const MAX_EXECUTOR_STATE_BYTES = 256 * 1024; // 256 KiB

// A "started" story has an executor-state.md carrying a Progress section — a
// markdown heading whose text begins with "Progress" (e.g. `## Progress`).
const PROGRESS_HEADING = /^#{1,6}\s*Progress/m;

const STORIES_REL_PATH = join('tasks', 'stories');
const EXECUTOR_STATE_FILE = 'executor-state.md';
const PHASE_MARKER_FILE = 'phase.md';

/** The five lowercase phase ids a `phase.md` marker may carry (rules/phase-markers.md). */
export type Phase = 'planning' | 'coding' | 'testing' | 'reviewing' | 'shipping';

const VALID_PHASES: readonly Phase[] = ['planning', 'coding', 'testing', 'reviewing', 'shipping'];

/** The lifecycle-relevant summary of a project's story workspace. */
export interface StoryStatesSummary {
  readonly hasStartedStory: boolean;
  readonly phase: Phase | null;
}

/**
 * Parse a `phase.md` marker per the `rules/phase-markers.md` contract: plain
 * `key: value` lines, FIRST occurrence of a key wins, unknown keys are ignored.
 * Requires `schemaVersion` to equal `1` and `phase` to be one of the five valid ids
 * — anything else (unrecognized schemaVersion, malformed/missing phase) returns
 * null, meaning "retain previous state". Never throws.
 */
export function parsePhaseMarker(content: string): Phase | null {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (key.length === 0 || values.has(key)) continue; // first occurrence wins
    values.set(key, line.slice(separatorIndex + 1).trim());
  }

  if (values.get('schemaVersion') !== '1') return null;

  const phase = values.get('phase');
  if (phase === undefined) return null;
  return (VALID_PHASES as readonly string[]).includes(phase) ? (phase as Phase) : null;
}

/**
 * Read and parse the `phase.md` marker of a single `tasks/stories/<id>/` directory.
 * Best-effort: a missing/unreadable file or a malformed/unrecognized marker yields
 * null. Never throws.
 */
async function readPhaseForStory(storyDir: string): Promise<Phase | null> {
  try {
    const raw = await fs.readFile(join(storyDir, PHASE_MARKER_FILE), 'utf8');
    const content = raw.slice(0, MAX_EXECUTOR_STATE_BYTES);
    return parsePhaseMarker(content);
  } catch {
    return null;
  }
}

/**
 * Whether a single `tasks/stories/<id>/` directory is a genuinely STARTED story:
 * its `executor-state.md` exists AND contains a Progress section. An empty folder,
 * a folder with only `brief.md`, or an executor-state.md without a Progress section
 * all return false. Never throws.
 */
async function isStartedStory(storyDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(join(storyDir, EXECUTOR_STATE_FILE), 'utf8');
    const content = raw.slice(0, MAX_EXECUTOR_STATE_BYTES);
    return PROGRESS_HEADING.test(content);
  } catch {
    return false;
  }
}

/**
 * Read the story state of `projectPath`. Best-effort: scans `tasks/stories/` and
 * reports whether any subdirectory is a genuinely started story (executor-state.md
 * with a Progress section). Returns a frozen summary on every path and NEVER throws
 * — a missing stories dir yields `{ hasStartedStory: false }`.
 */
export async function readStoryStates(projectPath: string): Promise<StoryStatesSummary> {
  const storiesDir = join(projectPath, STORIES_REL_PATH);

  let entries: readonly import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(storiesDir, { withFileTypes: true });
  } catch {
    return Object.freeze<StoryStatesSummary>({ hasStartedStory: false, phase: null });
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const storyDir = join(storiesDir, entry.name);
    if (await isStartedStory(storyDir)) {
      const phase = await readPhaseForStory(storyDir);
      return Object.freeze<StoryStatesSummary>({ hasStartedStory: true, phase });
    }
  }

  return Object.freeze<StoryStatesSummary>({ hasStartedStory: false, phase: null });
}
