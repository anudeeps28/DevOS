// Filesystem discovery scanner — finds candidate projects under the configured
// project roots.
//
// A "candidate" is a direct child directory of a root that contains a `.claude/`
// directory (i.e. it looks like a Claude Code project) and is not already pinned
// in the registry. Discovery is best-effort and read-only:
//
//  - Drop, don't throw: every disk read is wrapped in try/catch. An unreadable or
//    missing root, or an entry we can't stat, is silently skipped — scanCandidates
//    NEVER throws (mirrors the boundary-validation convention in ws-protocol.ts).
//  - Immutable: each Candidate is a fresh frozen object and the returned array is
//    frozen, de-duplicated by path across roots, and sorted by path ascending.
//  - Shallow: only direct children of each root are examined (no recursion), and
//    symlinks are skipped to avoid loops.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { Candidate } from '../ws-protocol.js';

// Hard cap on the number of candidates returned — a defense against a root that
// contains an unexpectedly huge number of project directories.
const MAX_CANDIDATES = 1000;

// Hard cap on the number of directory entries EXAMINED per root. MAX_CANDIDATES
// only bounds matches collected; this bounds the work done (the per-child stat in
// hasClaudeInstall) so a root full of non-`.claude/` folders can't cause an
// unbounded stat fan-out on every scan.
const MAX_ENTRIES_PER_ROOT = 10_000;

// The marker directory that identifies a Claude Code project.
const CLAUDE_DIR = '.claude';

/**
 * Determine whether `childPath` contains a `.claude/` DIRECTORY. Returns false
 * on any error (missing path, permission denied, or `.claude` is a file/symlink
 * rather than a directory). Never throws.
 */
async function hasClaudeInstall(childPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(join(childPath, CLAUDE_DIR));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan a single root for candidate project directories, appending frozen
 * Candidate objects into `collected` (keyed by path to de-duplicate). Skips the
 * whole root on any read error. Stops early once MAX_CANDIDATES is reached.
 */
async function scanRoot(
  root: string,
  pinnedPaths: ReadonlySet<string>,
  collected: Map<string, Candidate>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // Unreadable or missing root — skip it entirely.
    return;
  }

  let examined = 0;
  for (const entry of entries) {
    if (collected.size >= MAX_CANDIDATES) return;
    if (examined >= MAX_ENTRIES_PER_ROOT) return; // bound the stat fan-out per root
    if (!entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) continue; // avoid symlink loops
    examined += 1;

    const childPath = join(root, entry.name);
    if (pinnedPaths.has(childPath)) continue; // already pinned — not a candidate
    if (collected.has(childPath)) continue; // seen under an earlier root

    if (!(await hasClaudeInstall(childPath))) continue;

    collected.set(
      childPath,
      Object.freeze<Candidate>({
        path: childPath,
        displayName: entry.name,
        hasClaudeInstall: true,
      }),
    );
  }
}

/**
 * Discover candidate projects under `roots` that are not already pinned.
 *
 * For each root, reads its direct children and collects every child directory
 * that contains a `.claude/` directory. Symlinked entries and pinned paths are
 * skipped. Results are de-duplicated by path across roots, capped at
 * MAX_CANDIDATES, and returned as a frozen array sorted by path ascending.
 *
 * All disk I/O is wrapped in try/catch — this function never throws.
 */
export async function scanCandidates(
  roots: readonly string[],
  pinnedPaths: ReadonlySet<string>,
): Promise<readonly Candidate[]> {
  const collected = new Map<string, Candidate>();

  for (const root of roots) {
    if (collected.size >= MAX_CANDIDATES) break;
    await scanRoot(root, pinnedPaths, collected);
  }

  const sorted = Array.from(collected.values()).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return Object.freeze(sorted);
}
