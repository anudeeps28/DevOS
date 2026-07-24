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

/** The lifecycle-relevant summary of a project's story workspace. */
export interface StoryStatesSummary {
  readonly hasStartedStory: boolean;
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
    return Object.freeze<StoryStatesSummary>({ hasStartedStory: false });
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await isStartedStory(join(storiesDir, entry.name))) {
      return Object.freeze<StoryStatesSummary>({ hasStartedStory: true });
    }
  }

  return Object.freeze<StoryStatesSummary>({ hasStartedStory: false });
}
