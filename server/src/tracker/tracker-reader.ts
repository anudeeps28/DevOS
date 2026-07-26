// Best-effort tracker state reader for a project.
//
// Mirrors git/git-state-reader.ts's "drop, don't throw / frozen-return / hard-caps"
// template:
//
//  - Drop, don't throw: reading the manifest, resolving the adapter, and running it
//    are all wrapped so a missing manifest, a missing script, a non-zero exit, a
//    missing `bash`, a timeout, or malformed output all yield the frozen
//    "unreachable" shape — readTrackerState NEVER throws and NEVER rejects.
//  - Immutable: every return path is a fresh Object.freeze(...)'d TrackerState.
//  - Tracker-agnostic core: all backend knowledge lives in the project's OWN adapter
//    script and the quarantined normalizer (normalize.ts). This reader only reads the
//    manifest `tracker` field, runs the adapter, and forwards stdout to the normalizer.
//
// DEFERRED hardening: running a repo-local shell script is a real command-exec
// surface (unlike git-state's fixed `git status`). V1 scope is the user's own trusted
// local projects; path-confinement / script-trust hardening is folded into the
// Origin/token task (6h6hMMj3PX4Gjcr8), the same place git-state deferred its
// hardening. timeout / maxBuffer are scoped exactly as git-state does. Unlike
// git-state (which spawns the trusted `git` binary), the executed code here is
// repo-controlled, so the FULL server env is NOT handed to it — only an allowlisted
// subset (base shell vars + the tracker-CLI vars the adapters actually read) is
// passed, so unrelated server env (secrets, tokens, internal config) is not exposed.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { TrackerState, TrackerTask } from '../ws-protocol.js';
import { normalizeNextTask } from './normalize.js';
import { withSpawnSlot } from './spawn-limit.js';

const execFileAsync = promisify(execFile);

// Hard cap on how long the adapter may run before we give up and report unreachable.
const TRACKER_TIMEOUT_MS = 5000;

// Cap on captured stdout/stderr; a well-behaved adapter stays far under this.
const TRACKER_MAX_BUFFER_BYTES = 1024 * 1024; // 1 MiB

// Adapter location relative to the project root.
const MANIFEST_REL_PATH = join('.claude', '.harness-manifest.json');
const ADAPTER_REL_PATH = join('.claude', 'trackers', 'active', 'get-sprint-issues.sh');

// Base shell/locale env every adapter needs to run at all (find its CLI on PATH,
// read its per-user config under HOME, produce correct text output).
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TZ',
  'TMPDIR',
];

// Tracker-CLI vars the shipped adapters actually read (Todoist `td`, GitHub `gh`,
// ADO). Any env var beginning with one of these prefixes is passed through so a
// user who configures their tracker via env keeps working; everything else is dropped.
const ENV_PREFIX_ALLOWLIST: readonly string[] = [
  'TODOIST_',
  'GH_',
  'GITHUB_',
  'AZURE_',
  'ADO_',
];

/**
 * Build the minimal environment handed to a repo-local adapter script: the base
 * shell/locale allowlist plus any tracker-CLI-prefixed vars. Deliberately excludes
 * the bulk of `process.env` so an untrusted adapter cannot read unrelated secrets.
 */
function buildAdapterEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * The shape returned whenever tracker state cannot be determined: missing adapter,
 * non-zero exit, missing bash, timeout, or any other failure. `tracker` is carried
 * through when known (from the manifest) so the UI can still label the card.
 */
function unreachable(projectPath: string, tracker: string | null): TrackerState {
  return Object.freeze<TrackerState>({
    path: projectPath,
    reachable: false,
    tracker,
    nextTask: null,
  });
}

/**
 * Read the manifest `tracker` field for a project. Best-effort: a missing or
 * unreadable manifest, malformed JSON, or a non-string `tracker` all yield null.
 * Never throws.
 */
async function readTrackerField(projectPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(projectPath, MANIFEST_REL_PATH), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { tracker } = parsed as Record<string, unknown>;
    return typeof tracker === 'string' ? tracker : null;
  } catch {
    return null;
  }
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

/**
 * Whether an execFile rejection is a spawn failure (`code: 'ENOENT'` with a
 * `syscall` of `spawn <cmd>`) — i.e. the `bash` binary itself is missing, as
 * opposed to the adapter exiting non-zero or timing out.
 */
function isSpawnEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown; syscall?: unknown };
  if (err.code !== 'ENOENT') return false;
  return typeof err.syscall === 'string' && err.syscall.startsWith('spawn');
}

// `bash` is either present for the whole process lifetime or not, so warn at most
// once — a per-render reader would otherwise flood the log on every read.
let warnedBashUnavailable = false;

/**
 * Read the tracker state of `projectPath`. Best-effort: reads the manifest `tracker`
 * field, runs the project's own `.claude/trackers/active/get-sprint-issues.sh`
 * adapter, and normalizes its stdout into the top open TrackerTask. Returns a frozen
 * TrackerState on every path and NEVER throws or rejects — any failure yields the
 * "unreachable" shape.
 */
export async function readTrackerState(projectPath: string): Promise<TrackerState> {
  const tracker = await readTrackerField(projectPath);

  const scriptPath = join(projectPath, ADAPTER_REL_PATH);
  if (!(await fileExists(scriptPath))) {
    return unreachable(projectPath, tracker);
  }

  let stdout: string;
  try {
    ({ stdout } = await withSpawnSlot(() =>
      execFileAsync('bash', [scriptPath], {
        cwd: projectPath,
        timeout: TRACKER_TIMEOUT_MS,
        maxBuffer: TRACKER_MAX_BUFFER_BYTES,
        env: buildAdapterEnv(),
      }),
    ));
  } catch (error) {
    // Only a genuine missing-bash spawn ENOENT warrants a warning (like git-state
    // warns for a missing git binary). Every other failure — non-zero exit, timeout,
    // missing CLI inside the adapter — collapses to unreachable silently.
    if (isSpawnEnoent(error) && !warnedBashUnavailable) {
      warnedBashUnavailable = true;
      console.warn(`[tracker-reader] bash unavailable: ${String(error)}`);
    }
    return unreachable(projectPath, tracker);
  }

  const nextTask: TrackerTask | null = tracker === null ? null : normalizeNextTask(tracker, stdout);
  return Object.freeze<TrackerState>({
    path: projectPath,
    reachable: true,
    tracker,
    nextTask,
  });
}
