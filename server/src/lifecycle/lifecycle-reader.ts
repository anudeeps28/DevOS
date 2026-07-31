// Best-effort project lifecycle SIGNAL reader.
//
// Supplies the lifecycle signals a client cannot derive from the per-card git-state
// and tracker-state reads it already performs. The whole-project STAGE
// (New→Decide→Define→Build→Ship) is composed on the CLIENT (web/src/lib/lifecycle.ts)
// from these signals PLUS the client's already-fetched tracker-state — so the server
// does NOT re-shell the tracker adapter or re-run `git status` for the lifecycle
// (ARCHITECTURE §9.2/§9.6: "reuses the per-card local + tracker reads").
//
// This reader therefore reads only:
//   - local planning files (docs/SPEC.md, docs/ARCHITECTURE.md, PRD.md → Define;
//     grill-summary.md, decision-brief.md → Decide),
//   - the story workspace (a genuinely started tasks/stories/<id>/ → Build), and
//   - git facts NOT carried by GitState: a feature branch WITH commits (→ Build) and
//     a release tag (→ Ship; codePlatform:none, so tags are the honest floor).
//
// It does NOT call readTrackerState (the client reuses its tracker-state read) and it
// does NOT call readGitState's `git status` (the client reuses its git-state read).
//
// Mirrors the git/tracker readers' "drop, don't throw / frozen-return" template:
// every read is best-effort, readLifecycleSignals NEVER throws or rejects, and the
// return is a fresh Object.freeze(...)'d value. Nothing is stored/cached (§4 invariant).

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { LifecycleSignals } from '../ws-protocol.js';
import { readStoryStates } from './story-state-reader.js';

const execFileAsync = promisify(execFile);

// Same hard caps as git-state-reader — these are offline git calls.
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024; // 1 MiB
const GIT_HARDENING_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

// Default branches that do NOT count as a feature-branch Build signal.
const DEFAULT_BRANCHES: readonly string[] = ['main', 'master'];

// A "release" tag is a version tag: `v1.2.3` / `1.2.3` (optionally with a pre-release
// suffix). A plain dev/checkpoint tag (e.g. `wip`, `backup`) is NOT a Ship signal
// (ARCHITECTURE §9.2 Ship row: a *release* tag).
const RELEASE_TAG = /^v?\d+\.\d+(\.\d+)?([-.].+)?$/;

// Local planning-artifact signals, relative to the project root.
const DEFINE_DOC_PATHS: readonly string[] = [
  join('docs', 'SPEC.md'),
  join('docs', 'ARCHITECTURE.md'),
  'PRD.md',
];
const DECIDE_DOC_PATHS: readonly string[] = ['grill-summary.md', 'decision-brief.md'];

/** All-false signals — the shape returned on total failure. */
function emptySignals(): LifecycleSignals {
  return Object.freeze<LifecycleSignals>({
    hasDecideDocs: false,
    hasDefineDocs: false,
    hasStartedStory: false,
    phase: null,
    hasFeatureBranchCommits: false,
    hasReleaseTags: false,
  });
}

/** Whether `filePath` exists and is reachable. Never throws. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Whether any of `relPaths` exists under `projectPath`. Never throws. */
async function anyFileExists(projectPath: string, relPaths: readonly string[]): Promise<boolean> {
  const results = await Promise.all(relPaths.map((rel) => fileExists(join(projectPath, rel))));
  return results.some((present) => present);
}

/** Run a hardened, offline git command in `cwd`; resolves stdout, or null on any failure. */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...GIT_HARDENING_ARGS, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      env: GIT_ENV,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Whether the project is on a non-default branch that resolves to at least one
 * commit (ARCHITECTURE §9.2 Build: "a feature branch with commits"). An unborn
 * branch (empty repo, HEAD resolves to nothing) does NOT fire Build. Best-effort:
 * a non-repo / missing git / timeout yields false. Never throws.
 */
async function hasFeatureBranchCommits(projectPath: string): Promise<boolean> {
  const branchOut = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchOut === null) return false;
  const branch = branchOut.trim();
  if (branch.length === 0 || branch === 'HEAD' || DEFAULT_BRANCHES.includes(branch)) return false;
  // `rev-parse --verify HEAD` fails on an unborn branch (no commits yet).
  const head = await git(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return head !== null && head.trim().length > 0;
}

/**
 * Whether the repo has at least one RELEASE tag (a version tag). A non-release tag
 * does not count. Best-effort: a non-repo / missing git / timeout yields false.
 */
async function hasReleaseTags(projectPath: string): Promise<boolean> {
  const out = await git(projectPath, ['tag', '--list']);
  if (out === null) return false;
  return out.split('\n').some((line) => RELEASE_TAG.test(line.trim()));
}

/**
 * Read the lifecycle signals of `projectPath`. Best-effort: gathers local-file,
 * story, feature-branch-commit, and release-tag signals (each drop-don't-throw) and
 * returns a frozen LifecycleSignals. Does NOT read the tracker or `git status` — the
 * client reuses its per-card reads for those. NEVER throws or rejects.
 */
export async function readLifecycleSignals(projectPath: string): Promise<LifecycleSignals> {
  try {
    const [hasDefineDocs, hasDecideDocs, story, featureBranch, releaseTags] = await Promise.all([
      anyFileExists(projectPath, DEFINE_DOC_PATHS),
      anyFileExists(projectPath, DECIDE_DOC_PATHS),
      readStoryStates(projectPath),
      hasFeatureBranchCommits(projectPath),
      hasReleaseTags(projectPath),
    ]);

    return Object.freeze<LifecycleSignals>({
      hasDecideDocs,
      hasDefineDocs,
      hasStartedStory: story.hasStartedStory,
      phase: story.phase,
      hasFeatureBranchCommits: featureBranch,
      hasReleaseTags: releaseTags,
    });
  } catch {
    return emptySignals();
  }
}
