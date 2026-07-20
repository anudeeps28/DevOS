// Unit tests for the filesystem discovery scanner.
//
// Each test builds a real tmp fixture tree under os.tmpdir() (unique per test via
// crypto.randomUUID()) and tears it down afterwards. The scanner is best-effort
// and read-only: it must NEVER throw, must skip symlinks, must exclude pinned
// paths, and must return a frozen, de-duplicated, path-sorted array of frozen
// Candidate objects.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanCandidates } from './scanner.js';

// Root tmp dirs created during a test, cleaned up recursively in afterEach.
const createdRoots: string[] = [];

async function newTmpRoot(): Promise<string> {
  const root = join(tmpdir(), `devos-scannertest-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  createdRoots.push(root);
  return root;
}

/** Create `<root>/<name>` and, if withClaude, a `.claude/` DIRECTORY inside it. */
async function makeChild(root: string, name: string, withClaude: boolean): Promise<string> {
  const childPath = join(root, name);
  await fs.mkdir(childPath, { recursive: true });
  if (withClaude) {
    await fs.mkdir(join(childPath, '.claude'), { recursive: true });
  }
  return childPath;
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('scanCandidates', () => {
  let root: string;

  beforeEach(async () => {
    // Given: a fresh, empty tmp root for each test
    root = await newTmpRoot();
  });

  it('(a) returns a child containing a .claude/ directory as a candidate', async () => {
    // Given: a child folder with a real .claude/ directory
    const childPath = await makeChild(root, 'proj-a', true);

    // When: scanning the root with no pins
    const result = await scanCandidates([root], new Set());

    // Then: exactly that child is returned with the expected shape
    expect(result).toEqual([
      { path: childPath, displayName: 'proj-a', hasClaudeInstall: true },
    ]);
  });

  it('(b) does NOT return a sibling child without a .claude/ directory', async () => {
    // Given: one child with .claude/ and a sibling without it
    const withClaude = await makeChild(root, 'has-claude', true);
    await makeChild(root, 'no-claude', false);

    // When: scanning the root
    const result = await scanCandidates([root], new Set());

    // Then: only the .claude-bearing child is a candidate
    expect(result.map((c) => c.path)).toEqual([withClaude]);
  });

  it('(c) excludes a child whose path is in the pinnedPaths set', async () => {
    // Given: two candidate children, one of which is already pinned
    const pinned = await makeChild(root, 'pinned-proj', true);
    const unpinned = await makeChild(root, 'unpinned-proj', true);

    // When: scanning with the pinned path excluded
    const result = await scanCandidates([root], new Set([pinned]));

    // Then: only the un-pinned candidate is returned
    expect(result.map((c) => c.path)).toEqual([unpinned]);
  });

  it('(d) skips a missing/unreadable root without throwing (resolves to [])', async () => {
    // Given: a path that does not exist on disk
    const missing = join(tmpdir(), `devos-scannertest-missing-${randomUUID()}`);

    // When/Then: scanning it resolves to an empty array and never rejects
    await expect(scanCandidates([missing], new Set())).resolves.toEqual([]);
  });

  it('(e) skips a symlinked child directory', async () => {
    // Given: a real candidate dir and a sibling symlink pointing at it
    const realChild = await makeChild(root, 'real-proj', true);
    const linkPath = join(root, 'link-proj');

    let symlinkSupported = true;
    try {
      await fs.symlink(realChild, linkPath, 'dir');
    } catch {
      // Some platforms/permissions forbid symlink creation — skip that assertion.
      symlinkSupported = false;
    }

    // When: scanning the root
    const result = await scanCandidates([root], new Set());
    const paths = result.map((c) => c.path);

    // Then: the real dir is a candidate; the symlink entry is never returned
    expect(paths).toContain(realChild);
    if (symlinkSupported) {
      expect(paths).not.toContain(linkPath);
    }
  });

  it('(f) de-duplicates by path and sorts ascending across two roots', async () => {
    // Given: two roots, one shared as a duplicate, with names out of sort order
    const rootA = await newTmpRoot();
    const rootB = await newTmpRoot();
    const zChild = await makeChild(rootA, 'zeta', true);
    const aChild = await makeChild(rootA, 'alpha', true);
    const bChild = await makeChild(rootB, 'beta', true);

    // When: scanning rootA twice (duplicate) plus rootB
    const result = await scanCandidates([rootA, rootA, rootB], new Set());
    const paths = result.map((c) => c.path);

    // Then: each path appears once, sorted ascending by path
    const expected = [aChild, bChild, zChild].sort((x, y) =>
      x < y ? -1 : x > y ? 1 : 0,
    );
    expect(paths).toEqual(expected);
    expect(new Set(paths).size).toBe(paths.length); // no duplicates
  });

  it('(g) returns only the .claude child amid several bare siblings (entry-cap unaffected at fixture size)', async () => {
    // Given: one real candidate plus several bare (no-`.claude/`) sibling dirs.
    // The scanner caps entries EXAMINED per root at MAX_ENTRIES_PER_ROOT (10_000)
    // as a safety bound against a pathologically large root; that bound is NOT
    // exercised by this fixture (a handful of entries) and must not affect a
    // normal scan. We assert that here WITHOUT creating 10k dirs — the cap is a
    // guard, not a behavior a fixture of this size can reach.
    const alpha = await makeChild(root, 'alpha', true);
    for (const name of ['bare-1', 'bare-2', 'bare-3', 'bare-4', 'bare-5']) {
      await makeChild(root, name, false);
    }

    // When: scanning the root with no pins
    const result = await scanCandidates([root], new Set());

    // Then: exactly the alpha candidate is returned — the cap never interfered
    expect(result).toEqual([
      { path: alpha, displayName: 'alpha', hasClaudeInstall: true },
    ]);
  });

  it('freezes the returned array and each entry', async () => {
    // Given: a single candidate under the root
    await makeChild(root, 'frozen-proj', true);

    // When: scanning
    const result = await scanCandidates([root], new Set());

    // Then: the array and its entries are immutable
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it('never throws on a missing root and yields an empty result', async () => {
    // Given: only a non-existent root
    const missing = join(tmpdir(), `devos-scannertest-missing-${randomUUID()}`);

    // When/Then: the call resolves rather than rejecting
    await expect(scanCandidates([missing], new Set())).resolves.toEqual([]);
  });
});
