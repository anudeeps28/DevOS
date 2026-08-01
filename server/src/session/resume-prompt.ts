// Resume-prompt assembler — builds the kickoff prompt for a fresh build session that
// resumes a durable work item after a context recycle (SPEC context-recycle flow).
// Pure: takes the durable state as strings via an injected reader and returns a single
// string. Never throws — a missing/unreadable artifact is skipped silently so the
// resume prompt degrades gracefully rather than blocking the new session's spawn.

/** Story artifacts read (in order) to assemble the resume prompt, mirroring the
 * builder/reviewer handoff contract in `tasks/stories/<id>/`. */
export const RESUME_STORY_FILES = ['plan.md', 'executor-state.md', 'phase.md', 'evaluation.md'] as const;

export interface ResumeInputs {
  readonly workItemId: string;
  readonly taskDescription?: string;
  readonly acceptanceCriteria?: string;
}

/** Reads a single story artifact by filename; null when absent/unreadable. */
export type ReadArtifact = (file: string) => string | null;

// Cap each interpolated section so a pathological artifact can't blow up the prompt —
// mirrors the 256 KiB story-artifact read cap used elsewhere (bridge.ts), but tighter
// since this text is interpolated directly into a session kickoff prompt.
const MAX_SECTION_BYTES = 32 * 1024; // 32 KiB

const FILE_TITLES: Record<(typeof RESUME_STORY_FILES)[number], string> = {
  'plan.md': 'Task plan',
  'executor-state.md': 'Executor state',
  'phase.md': 'Phase marker',
  'evaluation.md': 'Evaluation / review notes',
};

/**
 * Assemble the kickoff prompt for a fresh build session resuming durable work item
 * `inputs.workItemId`. Reads each of `RESUME_STORY_FILES` via `readArtifact`, skipping
 * any that return null, and always closes with a directive to inspect the committed
 * working tree. Pure; never throws.
 */
export function buildResumePrompt(inputs: ResumeInputs, readArtifact: ReadArtifact): string {
  const sections: string[] = [];

  sections.push(
    `This is a context-recycle RESUME of durable work item "${inputs.workItemId}", not a fresh start. ` +
      'A prior session already made progress on this work item and its context was recycled. ' +
      'Resume from the state files and working tree described below. ' +
      'DO NOT assume any prior in-context memory of this work — none is available to you. ' +
      'NEVER rely on conversation compaction to recover lost context; the durable files and the ' +
      'committed working tree are the ONLY source of truth for what has already been done.',
  );

  if (inputs.taskDescription !== undefined) {
    sections.push(`## Task\n\n${inputs.taskDescription.slice(0, MAX_SECTION_BYTES)}`);
  }

  if (inputs.acceptanceCriteria !== undefined) {
    sections.push(`## Acceptance criteria\n\n${inputs.acceptanceCriteria.slice(0, MAX_SECTION_BYTES)}`);
  }

  for (const file of RESUME_STORY_FILES) {
    const content = readArtifact(file);
    if (content === null) continue;
    sections.push(`## ${FILE_TITLES[file]} (${file})\n\n${content.slice(0, MAX_SECTION_BYTES)}`);
  }

  sections.push(
    '## Code so far\n\n' +
      'Before continuing, inspect the committed working tree at the current working directory — ' +
      'run `git log` and `git status` to see what has already been committed for this work item. ' +
      'Treat that working tree as the authoritative record of progress, alongside the state files above.',
  );

  return sections.join('\n\n');
}
