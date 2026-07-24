// Best-effort git state reader for a project working tree.
//
// Mirrors the discovery scanner's "drop, don't throw / frozen-return / hard-caps"
// template (see ../discovery/scanner.ts):
//
//  - Drop, don't throw: every git invocation is wrapped in try/catch. A non-git
//    directory, a missing path, a missing git binary, a timeout, or any other
//    rejection yields the frozen "unavailable" shape — readGitState NEVER throws
//    and NEVER rejects.
//  - Immutable: every return path is a fresh Object.freeze(...)'d GitState.
//  - Read-only + offline: a single `git status --porcelain=v2 --branch` call; no
//    `git fetch`, no network, no shell, no new dependency.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

import type { GitState } from '../ws-protocol.js';

const execFileAsync = promisify(execFile);

// Hard cap on how long git may run before we give up and report "unavailable".
const GIT_TIMEOUT_MS = 5000;

// Defense-in-depth: DevOS points `git status` at arbitrary local repos, and a
// malicious repo's own `.git/config` can turn a plain `git status` into command
// execution (`core.fsmonitor`, a hook via `core.hooksPath`). These command-line
// `-c` overrides neuter those knobs per-invocation without touching the repo's
// real config (branch.upstream etc. are still read normally). `GIT_OPTIONAL_LOCKS=0`
// keeps a read-only status from taking index locks. No network is ever involved.
const GIT_HARDENING_ARGS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

// Cap on captured stdout/stderr. Porcelain v2 --branch output for even a large
// working tree stays well under this; the cap defends against a pathological repo.
const GIT_MAX_BUFFER_BYTES = 1024 * 1024; // 1 MiB

/**
 * The shape returned whenever git state cannot be determined: not a repo, missing
 * path, bare repo, git binary absent, timeout, or any other failure.
 */
function unavailable(projectPath: string): GitState {
  return Object.freeze<GitState>({
    path: projectPath,
    isRepo: false,
    branch: null,
    detached: false,
    dirty: false,
    ahead: null,
    behind: null,
    upstream: null,
  });
}

/** Accumulator for the header fields parsed out of porcelain v2 output. */
interface HeaderState {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

/**
 * Parse a `# branch.ab +<A> -<B>` header value (the part after `branch.ab`).
 * The value is two space-separated tokens: `+N` (ahead) and `-M` (behind).
 * Returns null if the tokens are missing or not the expected `+num`/`-num` form,
 * so a malformed line leaves ahead/behind at their `null` default (never 0/0).
 */
function parseAheadBehind(value: string): { ahead: number; behind: number } | null {
  const tokens = value.split(' ').filter((t) => t.length > 0);
  const aheadTok = tokens[0];
  const behindTok = tokens[1];
  if (aheadTok === undefined || behindTok === undefined) return null;
  if (aheadTok[0] !== '+' || behindTok[0] !== '-') return null;

  const ahead = Number.parseInt(aheadTok.slice(1), 10);
  const behind = Number.parseInt(behindTok.slice(1), 10);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null;

  return { ahead, behind };
}

/**
 * Fold a single porcelain v2 line into the header accumulator. Only `# `-prefixed
 * header lines mutate the (local, non-shared) accumulator; the caller tracks
 * dirtiness separately from the presence of any non-header line.
 */
function applyHeaderLine(line: string, header: HeaderState): void {
  // `# branch.head <name>` — literal `(detached)` marks a detached HEAD.
  if (line.startsWith('# branch.head ')) {
    const name = line.slice('# branch.head '.length);
    if (name === '(detached)') {
      header.detached = true;
      header.branch = null;
    } else {
      header.detached = false;
      header.branch = name;
    }
    return;
  }

  // `# branch.upstream <ref>` — absence of this line means no upstream (null).
  if (line.startsWith('# branch.upstream ')) {
    header.upstream = line.slice('# branch.upstream '.length);
    return;
  }

  // `# branch.ab +<A> -<B>` — absence means no upstream, so ahead/behind stay null.
  if (line.startsWith('# branch.ab ')) {
    const parsed = parseAheadBehind(line.slice('# branch.ab '.length));
    if (parsed !== null) {
      header.ahead = parsed.ahead;
      header.behind = parsed.behind;
    }
    return;
  }
}

/**
 * Build a GitState from successful porcelain v2 `--branch` output.
 * Any non-`# ` line (a tracked/untracked change entry) implies a dirty tree.
 */
function parsePorcelain(projectPath: string, stdout: string): GitState {
  const header: HeaderState = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
  };
  let dirty = false;

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    if (line.startsWith('# ')) {
      applyHeaderLine(line, header);
    } else {
      dirty = true;
    }
  }

  return Object.freeze<GitState>({
    path: projectPath,
    isRepo: true,
    branch: header.branch,
    detached: header.detached,
    dirty,
    ahead: header.ahead,
    behind: header.behind,
    upstream: header.upstream,
  });
}

/**
 * Whether an execFile rejection is a spawn failure (`code: 'ENOENT'` with a
 * `syscall` of `spawn <cmd>`). Node reports the SAME error both when the git
 * binary is absent AND when the cwd doesn't exist, so this alone can't tell the
 * two apart — the caller disambiguates via a cwd existence check.
 */
function isSpawnEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown; syscall?: unknown };
  if (err.code !== 'ENOENT') return false;
  return typeof err.syscall === 'string' && err.syscall.startsWith('spawn');
}

// The git binary is either present for the whole process lifetime or not, so warn
// at most once — a per-render reader would otherwise flood the log on every read.
let warnedGitUnavailable = false;

/** Whether `dirPath` exists and is reachable. Never throws. */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    await fs.access(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the git state of `projectPath`. Best-effort and offline: runs a single
 * `git status --porcelain=v2 --branch` and derives branch, detached, dirty,
 * ahead/behind, and upstream from it. Returns a frozen GitState on every path
 * and NEVER throws or rejects — any failure yields the "unavailable" shape.
 */
export async function readGitState(projectPath: string): Promise<GitState> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...GIT_HARDENING_ARGS, 'status', '--porcelain=v2', '--branch'],
      {
        cwd: projectPath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        // Read-only status must not take index locks.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
    );
    return parsePorcelain(projectPath, stdout);
  } catch (error) {
    // A spawn ENOENT means EITHER the git binary is missing OR the cwd is gone
    // (Node reports them identically). Only the former warrants a warning; if the
    // directory itself is absent it's simply "not a repo" (missing path). Every
    // other failure — non-git dir, bare repo, timeout, exit non-zero — collapses
    // to the same unavailable shape silently.
    if (isSpawnEnoent(error) && !warnedGitUnavailable && (await dirExists(projectPath))) {
      warnedGitUnavailable = true;
      console.warn(`[git-state-reader] git unavailable: ${String(error)}`);
    }
    return unavailable(projectPath);
  }
}
