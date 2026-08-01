// Unit tests — buildResumePrompt's pure prompt assembly (no I/O; readArtifact is injected).

import { describe, expect, it } from 'vitest';
import { RESUME_STORY_FILES, buildResumePrompt, type ReadArtifact } from './resume-prompt.js';

const NO_ARTIFACTS: ReadArtifact = () => null;

describe('buildResumePrompt', () => {
  it('includes the task description and acceptance criteria when present', () => {
    const prompt = buildResumePrompt(
      { workItemId: 'WORK-1', taskDescription: 'Add dark mode', acceptanceCriteria: 'Toggle persists' },
      NO_ARTIFACTS,
    );
    expect(prompt).toContain('## Task');
    expect(prompt).toContain('Add dark mode');
    expect(prompt).toContain('## Acceptance criteria');
    expect(prompt).toContain('Toggle persists');
  });

  it('omits the task/AC sections entirely when absent', () => {
    const prompt = buildResumePrompt({ workItemId: 'WORK-1' }, NO_ARTIFACTS);
    expect(prompt).not.toContain('## Task');
    expect(prompt).not.toContain('## Acceptance criteria');
  });

  it('appends a titled section for each present story file, in RESUME_STORY_FILES order', () => {
    const content: Record<string, string> = {
      'plan.md': 'PLAN CONTENT',
      'phase.md': 'PHASE CONTENT',
    };
    const readArtifact: ReadArtifact = (file) => content[file] ?? null;

    const prompt = buildResumePrompt({ workItemId: 'WORK-1' }, readArtifact);

    expect(prompt).toContain('## Task plan (plan.md)');
    expect(prompt).toContain('PLAN CONTENT');
    expect(prompt).toContain('## Phase marker (phase.md)');
    expect(prompt).toContain('PHASE CONTENT');

    const planIndex = prompt.indexOf('## Task plan');
    const phaseIndex = prompt.indexOf('## Phase marker');
    expect(planIndex).toBeGreaterThan(-1);
    expect(phaseIndex).toBeGreaterThan(planIndex);
  });

  it('skips files whose readArtifact returns null', () => {
    const readArtifact: ReadArtifact = (file) => (file === 'plan.md' ? 'PLAN CONTENT' : null);

    const prompt = buildResumePrompt({ workItemId: 'WORK-1' }, readArtifact);

    expect(prompt).toContain('## Task plan (plan.md)');
    for (const file of RESUME_STORY_FILES) {
      if (file === 'plan.md') continue;
      expect(prompt).not.toContain(`(${file})`);
    }
  });

  it('always contains the never-compact directive and the code-so-far directive', () => {
    const prompt = buildResumePrompt({ workItemId: 'WORK-1' }, NO_ARTIFACTS);
    expect(prompt).toMatch(/NEVER rely on conversation compaction/i);
    expect(prompt).toContain('## Code so far');
    expect(prompt).toMatch(/git log/);
    expect(prompt).toMatch(/git status/);
  });

  it('bounds an oversized file section at the section cap', () => {
    const huge = 'x'.repeat(64 * 1024); // 64 KiB, double the 32 KiB cap
    const readArtifact: ReadArtifact = (file) => (file === 'plan.md' ? huge : null);

    const prompt = buildResumePrompt({ workItemId: 'WORK-1' }, readArtifact);

    const sectionStart = prompt.indexOf('## Task plan (plan.md)');
    expect(sectionStart).toBeGreaterThan(-1);
    const nextSectionStart = prompt.indexOf('## Code so far');
    const section = prompt.slice(sectionStart, nextSectionStart);
    // Cap is 32 KiB; the section (title + body) must not carry the full 64 KiB payload.
    expect(section.length).toBeLessThan(huge.length);
    expect(section.length).toBeLessThanOrEqual(32 * 1024 + 200);
  });

  it('never throws even when readArtifact itself is degenerate for every file', () => {
    expect(() => buildResumePrompt({ workItemId: 'WORK-1' }, NO_ARTIFACTS)).not.toThrow();
  });
});
