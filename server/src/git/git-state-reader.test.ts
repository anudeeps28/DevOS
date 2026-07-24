// Unit tests for the best-effort git state reader.
//
// Each test builds a REAL git repository (or a plain dir) under os.tmpdir(),
// unique per test via crypto.randomUUID(), and tears it down in afterEach.
// Fixtures run git through execFile with an inline identity and a neutered global
// config so no ambient git identity is needed and nothing touches the network.
// The reader is best-effort and offline: it returns a frozen GitState and NEVER
// throws or rejects.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { readGitState } from './git-state-reader.js';

const execFileAsync = promisify(execFile);

// Root tmp dirs created during a test, cleaned up recursively in afterEach.
const createdRoots: string[] = [];

// Inline identity + deterministic config so no global/system git identity is
// required and commits never wait on a signing key or a network.
const GIT_IDENTITY_ARGS = [
  '-c',
  'user.email=t@t.t',
  '-c',
  'user.name=Test',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

// Fully isolate from the developer's own git config (aliases, hooksPath, etc.).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** Run git in `cwd` with the isolated identity/env; returns trimmed stdout. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_IDENTITY_ARGS, ...args], {
    cwd,
    env: GIT_ENV,
  });
  return stdout.trim();
}

async function newTmpRoot(prefix: string): Promise<string> {
  const root = join(tmpdir(), `devos-gitreadertest-${prefix}-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  createdRoots.push(root);
  return root;
}

/** Init a repo at `dir` and land one commit on `main` with a tracked file. */
async function initRepoWithCommit(dir: string): Promise<void> {
  await git(dir, ['init']);
  await fs.writeFile(join(dir, 'file.txt'), 'v1\n');
  await git(dir, ['add', 'file.txt']);
  await git(dir, ['commit', '-m', 'initial']);
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('readGitState', () => {
  it('(a) reports a clean single-commit repo on main', async () => {
    // Given: a fresh repo with one commit on `main` and a clean tree
    const dir = await newTmpRoot('clean');
    await initRepoWithCommit(dir);

    // When: reading its git state
    const state = await readGitState(dir);

    // Then: it is a repo, on main, attached, and clean
    expect(state.isRepo).toBe(true);
    expect(state.branch).toBe('main');
    expect(state.detached).toBe(false);
    expect(state.dirty).toBe(false);
  });

  it('(b) reports dirty when a tracked file is modified without committing', async () => {
    // Given: a clean repo whose tracked file is then modified in the working tree
    const dir = await newTmpRoot('dirty');
    await initRepoWithCommit(dir);
    await fs.writeFile(join(dir, 'file.txt'), 'v2-uncommitted\n');

    // When: reading its git state
    const state = await readGitState(dir);

    // Then: the tree is reported dirty
    expect(state.isRepo).toBe(true);
    expect(state.dirty).toBe(true);
  });

  it('(c) reports exact ahead/behind against a local (offline) upstream', async () => {
    // Given: a bare "origin" and a working clone that pushes, then diverges from
    // its upstream WITHOUT any fetch/network:
    //   - push c1  -> local == origin/main
    //   - commit c2, c3, push -> origin/main == c3
    //   - reset --hard c1 -> local behind origin/main by 2 (c2, c3)
    //   - commit c4 -> local ahead of origin/main by 1 (c4)
    // Net: ahead:1, behind:2 relative to the tracked upstream.
    const root = await newTmpRoot('aheadbehind');
    const bare = join(root, 'origin.git');
    const work = join(root, 'work');
    await fs.mkdir(work, { recursive: true });
    await git(root, ['init', '--bare', 'origin.git']);

    await initRepoWithCommit(work);
    const c1 = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['remote', 'add', 'origin', bare]);
    await git(work, ['push', '-u', 'origin', 'main']);

    await fs.writeFile(join(work, 'file.txt'), 'v2\n');
    await git(work, ['commit', '-am', 'c2']);
    await fs.writeFile(join(work, 'file.txt'), 'v3\n');
    await git(work, ['commit', '-am', 'c3']);
    await git(work, ['push', 'origin', 'main']);

    await git(work, ['reset', '--hard', c1]);
    await fs.writeFile(join(work, 'other.txt'), 'c4\n');
    await git(work, ['add', 'other.txt']);
    await git(work, ['commit', '-m', 'c4']);

    // When: reading its git state
    const state = await readGitState(work);

    // Then: ahead/behind reflect the diverged upstream exactly
    expect(state.isRepo).toBe(true);
    expect(state.branch).toBe('main');
    expect(state.ahead).toBe(1);
    expect(state.behind).toBe(2);
    expect(state.upstream).toBe('origin/main');
  });

  it('(d) reports null ahead/behind/upstream when no upstream is configured', async () => {
    // Given: a repo whose branch has no upstream tracking ref
    const dir = await newTmpRoot('noupstream');
    await initRepoWithCommit(dir);

    // When: reading its git state
    const state = await readGitState(dir);

    // Then: ahead/behind/upstream are null (NOT 0) — no upstream means unknown
    expect(state.isRepo).toBe(true);
    expect(state.ahead).toBeNull();
    expect(state.behind).toBeNull();
    expect(state.upstream).toBeNull();
  });

  it('(e) reports detached HEAD with a null branch', async () => {
    // Given: a repo checked out directly at a commit sha (detached HEAD)
    const dir = await newTmpRoot('detached');
    await initRepoWithCommit(dir);
    const sha = await git(dir, ['rev-parse', 'HEAD']);
    await git(dir, ['checkout', sha]);

    // When: reading its git state
    const state = await readGitState(dir);

    // Then: HEAD is detached and no branch name is reported
    expect(state.isRepo).toBe(true);
    expect(state.detached).toBe(true);
    expect(state.branch).toBeNull();
  });

  it('(f) resolves to the unavailable shape for a plain non-git dir (never rejects)', async () => {
    // Given: an ordinary tmp directory that is not a git repository
    const dir = await newTmpRoot('nongit');

    // When: reading its git state
    const state = await readGitState(dir);

    // Then: it resolves as "not a repo" with all git fields null/false
    expect(state.isRepo).toBe(false);
    expect(state.branch).toBeNull();
    expect(state.detached).toBe(false);
    expect(state.dirty).toBe(false);
    expect(state.ahead).toBeNull();
    expect(state.behind).toBeNull();
    expect(state.upstream).toBeNull();
  });

  it('(g) resolves to the unavailable shape for a path that does not exist', async () => {
    // Given: a path that was never created on disk
    const missing = join(tmpdir(), `devos-gitreadertest-missing-${randomUUID()}`);

    // When/Then: the call resolves rather than rejecting
    const state = await readGitState(missing);
    expect(state.isRepo).toBe(false);
    expect(state.branch).toBeNull();
    expect(state.detached).toBe(false);
    expect(state.dirty).toBe(false);
  });

  it('(h) returns a frozen GitState object', async () => {
    // Given: any repo
    const dir = await newTmpRoot('frozen');
    await initRepoWithCommit(dir);

    // When: reading its git state
    const state = await readGitState(dir);

    // Then: the returned object is immutable
    expect(Object.isFrozen(state)).toBe(true);
  });
});
