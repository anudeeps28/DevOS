import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { readLifecycleSignals } from './lifecycle-reader.js';

const execFileAsync = promisify(execFile);

// Tmp fixtures torn down in afterEach.
const created: string[] = [];

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const root = join(tmpdir(), `lifecycle-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  created.push(root);
  return root;
}

// Deterministic git identity + no signing, so commits succeed on any host/CI.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

// Neutralize any host-global GPG/annotated-tag signing so lightweight tags and
// commits succeed deterministically on any dev machine / CI.
const GIT_NOSIGN = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', '-c', 'tag.forceSignAnnotated=false'];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', [...GIT_NOSIGN, ...args], { cwd, env: GIT_ENV });
}

afterEach(async () => {
  await Promise.all(created.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  created.length = 0;
});

describe('readLifecycleSignals — local-file + story signals', () => {
  it('AC1: docs/SPEC.md + docs/ARCHITECTURE.md present, no started story → hasDefineDocs only', async () => {
    const root = await makeProject({ 'docs/SPEC.md': '# Spec', 'docs/ARCHITECTURE.md': '# Arch' });
    const s = await readLifecycleSignals(root);
    expect(s.hasDefineDocs).toBe(true);
    expect(s.hasStartedStory).toBe(false);
    expect(s.hasDecideDocs).toBe(false);
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('a grill-summary alone → hasDecideDocs only', async () => {
    const root = await makeProject({ 'grill-summary.md': '# Grill' });
    const s = await readLifecycleSignals(root);
    expect(s.hasDecideDocs).toBe(true);
    expect(s.hasDefineDocs).toBe(false);
  });

  it('AC2: a started tasks/stories/<id>/ (Progress section) → hasStartedStory', async () => {
    const root = await makeProject({
      'tasks/stories/S1/executor-state.md': '## Progress\n\n| Task | Result |\n',
    });
    const s = await readLifecycleSignals(root);
    expect(s.hasStartedStory).toBe(true);
  });

  it('an empty story folder does not fire hasStartedStory', async () => {
    const root = await makeProject({ 'tasks/stories/S1/brief.md': '# Brief' });
    const s = await readLifecycleSignals(root);
    expect(s.hasStartedStory).toBe(false);
  });

  it('a bare project has all-false signals and never throws', async () => {
    const root = await makeProject({ 'README.md': 'hi' });
    const s = await readLifecycleSignals(root);
    expect(s).toEqual({
      hasDecideDocs: false,
      hasDefineDocs: false,
      hasStartedStory: false,
      hasFeatureBranchCommits: false,
      hasReleaseTags: false,
    });
  });

  it('never throws on a non-existent path', async () => {
    const s = await readLifecycleSignals(join(tmpdir(), `missing-${randomUUID()}`));
    expect(s.hasStartedStory).toBe(false);
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('two sequential reads return equal signals (live-derived, never cached)', async () => {
    const root = await makeProject({ 'docs/SPEC.md': '# Spec' });
    const a = await readLifecycleSignals(root);
    const b = await readLifecycleSignals(root);
    expect(a).toEqual(b);
  });
});

describe('readLifecycleSignals — git signals (precision)', () => {
  it('a default-branch repo does NOT fire hasFeatureBranchCommits', async () => {
    const root = await makeProject({ 'README.md': 'x' });
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-q', '-m', 'init']);
    const s = await readLifecycleSignals(root);
    expect(s.hasFeatureBranchCommits).toBe(false);
  });

  it('a non-default branch with a commit fires hasFeatureBranchCommits', async () => {
    const root = await makeProject({ 'README.md': 'x' });
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-q', '-m', 'init']);
    await git(root, ['checkout', '-q', '-b', 'feature/x']);
    const s = await readLifecycleSignals(root);
    expect(s.hasFeatureBranchCommits).toBe(true);
  });

  it('a RELEASE tag (v1.2.3) fires hasReleaseTags', async () => {
    const root = await makeProject({ 'README.md': 'x' });
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-q', '-m', 'init']);
    await git(root, ['tag', 'v1.2.3']);
    const s = await readLifecycleSignals(root);
    expect(s.hasReleaseTags).toBe(true);
  });

  it('a NON-release tag (wip) does NOT fire hasReleaseTags', async () => {
    const root = await makeProject({ 'README.md': 'x' });
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-q', '-m', 'init']);
    await git(root, ['tag', 'wip-checkpoint']);
    const s = await readLifecycleSignals(root);
    expect(s.hasReleaseTags).toBe(false);
  });
});
