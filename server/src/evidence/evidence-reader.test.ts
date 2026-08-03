// Unit tests — evidence reader (changed files + artifacts + test-results + PR summary).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEvidence } from './evidence-reader.js';

let tmpDir: string | null = null;

/** Create a fresh tmp project dir (not a git repo unless the caller inits one). */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devos-evidence-reader-'));
  tmpDir = dir;
  return dir;
}

/** Write `tasks/stories/<workItemId>/<fileName>` with `content` for `projectPath`. */
function writeStoryFile(projectPath: string, workItemId: string, fileName: string, content: string): void {
  const dir = join(projectPath, 'tasks', 'stories', workItemId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), content, 'utf8');
}

afterEach(() => {
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('readEvidence', () => {
  it('yields all-empty frozen EvidenceData when the story dir is missing, never throws', async () => {
    const dir = makeProject();

    const evidence = await readEvidence(dir, 'WI-missing');

    expect(evidence).toEqual({
      filesChanged: [],
      testResults: { summary: '' },
      prSummary: '',
      artifacts: [],
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.filesChanged)).toBe(true);
    expect(Object.isFrozen(evidence.artifacts)).toBe(true);
    expect(Object.isFrozen(evidence.testResults)).toBe(true);
  });

  it('badges artifacts Final when phase.md carries phase: shipping', async () => {
    const dir = makeProject();
    writeStoryFile(dir, 'WI-1', 'brief.md', 'brief content');
    writeStoryFile(
      dir,
      'WI-1',
      'phase.md',
      'schemaVersion: 1\nphase: shipping\nrole: builder\nupdated: 2026-07-31T18:56:35Z\nskill: implement\ndetail: test\n',
    );

    const evidence = await readEvidence(dir, 'WI-1');

    expect(evidence.artifacts).toEqual([{ name: 'brief.md', state: 'Final' }]);
  });

  it('badges artifacts Draft when phase.md is absent', async () => {
    const dir = makeProject();
    writeStoryFile(dir, 'WI-1', 'brief.md', 'brief content');

    const evidence = await readEvidence(dir, 'WI-1');

    expect(evidence.artifacts).toEqual([{ name: 'brief.md', state: 'Draft' }]);
  });

  it('lists only the artifacts present, in allowlist order', async () => {
    const dir = makeProject();
    writeStoryFile(dir, 'WI-1', 'plan.md', 'plan content');
    writeStoryFile(dir, 'WI-1', 'brief.md', 'brief content');
    writeStoryFile(dir, 'WI-1', 'decisions-log.md', 'decisions content');

    const evidence = await readEvidence(dir, 'WI-1');

    expect(evidence.artifacts.map((a) => a.name)).toEqual(['brief.md', 'plan.md', 'decisions-log.md']);
  });

  it('yields an empty test-results summary when no regression.log/evaluation.md/acceptance.md exist', async () => {
    const dir = makeProject();
    writeStoryFile(dir, 'WI-1', 'brief.md', 'brief content');

    const evidence = await readEvidence(dir, 'WI-1');

    expect(evidence.testResults.summary).toBe('');
  });

  it('uses regression.log content for the test-results summary when present', async () => {
    const dir = makeProject();
    writeStoryFile(dir, 'WI-1', 'regression.log', 'all green');

    const evidence = await readEvidence(dir, 'WI-1');

    expect(evidence.testResults.summary).toBe('all green');
  });

  it('uses pr-body.md content for the PR summary when present', async () => {
    const dir = makeProject();
    writeStoryFile(dir, 'WI-1', 'pr-body.md', 'PR summary text');

    const evidence = await readEvidence(dir, 'WI-1');

    expect(evidence.prSummary).toBe('PR summary text');
  });

  it('yields an empty filesChanged for a non-repo projectPath', async () => {
    const dir = makeProject();

    const evidence = await readEvidence(dir, 'WI-1');

    expect(evidence.filesChanged).toEqual([]);
  });

  it('yields empty EvidenceData when workItemId is an unsafe traversal payload', async () => {
    const dir = makeProject();
    writeStoryFile(dir, 'WI-1', 'brief.md', 'brief content');

    const evidence = await readEvidence(dir, '../etc');

    expect(evidence).toEqual({
      filesChanged: [],
      testResults: { summary: '' },
      prSummary: '',
      artifacts: [],
    });
    expect(Object.isFrozen(evidence)).toBe(true);
  });
});
