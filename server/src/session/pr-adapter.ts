// Injectable open-PR adapter seam — the AC4 mechanical PR-open used by the Bridge on
// a reviewer CLEAR verdict.
//
// Mirrors the QueryFn seam (session-engine.ts) and the tracker-reader.ts drop-don't-
// throw template: a narrow interface (`OpenPrAdapter`), a real-shell default
// (`defaultOpenPr`), and an easy fake for tests. The real default shells
// `.claude/code-platform/active/open-pr.sh` — a script that does NOT exist under
// `codePlatform:none` (V1's only shipped platform config), so the default LOUDLY
// fails (`{ ok:false, error }`) rather than silently succeeding; the Bridge parks a
// Needs-you inbox item on that failure. Every value that reaches the script — title,
// composed body, and any work-item id — rides as a discrete argv element via
// `execFile` (shell:false, never a shell string), so glob/bracket-significant
// content (e.g. a model id like `claude-opus-5[1m]`) is never shell-interpreted.

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Parameters for opening a PR from the drafted body + review verdict/advisory lists. */
export interface OpenPrParams {
  readonly projectPath: string;
  readonly title: string;
  readonly body: string;
  readonly verdicts: readonly string[];
  readonly advisories: readonly string[];
  readonly workItemId?: string;
}

/** The outcome of an open-PR attempt — a discriminated union, never a thrown error. */
export type OpenPrResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

/** The injectable open-PR seam. `defaultOpenPr` (below) is the real-shell default. */
export type OpenPrAdapter = (params: OpenPrParams) => Promise<OpenPrResult>;

// Adapter script location relative to the project root.
const ADAPTER_REL_PATH = join('.claude', 'code-platform', 'active', 'open-pr.sh');

// Hard cap on how long the adapter may run before giving up.
const OPEN_PR_TIMEOUT_MS = 15000;

// Cap on captured stdout/stderr.
const OPEN_PR_MAX_BUFFER_BYTES = 1024 * 1024; // 1 MiB

/** Compose the final PR body: the drafted body plus an appended verdicts/advisories section. */
function composeBody(params: OpenPrParams): string {
  const verdictsSection =
    params.verdicts.length > 0
      ? `\n\n## Review verdicts\n${params.verdicts.map((v) => `- ${v}`).join('\n')}`
      : '';
  const advisoriesSection =
    params.advisories.length > 0
      ? `\n\n## Advisories\n${params.advisories.map((a) => `- ${a}`).join('\n')}`
      : '';
  return `${params.body}${verdictsSection}${advisoriesSection}`;
}

/** Build the argv passed to the adapter script — every dynamic value is a discrete
 * argv element, never interpolated into a shell string. */
function buildArgs(scriptPath: string, params: OpenPrParams, body: string): readonly string[] {
  const args = [scriptPath, '--project', params.projectPath, '--title', params.title, '--body', body];
  if (params.workItemId !== undefined) args.push('--work-item', params.workItemId);
  return args;
}

/**
 * Whether an execFile rejection is a spawn failure (the adapter script or `bash`
 * itself is missing) rather than the script running and exiting non-zero.
 */
function isSpawnEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: unknown; syscall?: unknown };
  if (err.code !== 'ENOENT') return false;
  return typeof err.syscall === 'string' && err.syscall.startsWith('spawn');
}

/** Extract a non-empty error message from an execFile rejection. */
function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const err = error as { stderr?: unknown; message?: unknown };
    if (typeof err.stderr === 'string' && err.stderr.trim().length > 0) return err.stderr.trim();
    if (typeof err.message === 'string' && err.message.trim().length > 0) return err.message.trim();
  }
  return String(error);
}

/**
 * Build the real-shell `OpenPrAdapter`: composes the final body, then invokes the
 * adapter script (`scriptRelPath`, relative to `projectPath`, defaulting to
 * `.claude/code-platform/active/open-pr.sh`) via `execFile('bash', argv, …)` —
 * shell:false, every dynamic value as a discrete argv element. Under
 * `codePlatform:none` the script does not exist, so `execFile` fails with ENOENT —
 * this resolves `{ ok:false, error }` (LOUD failure), never a silent success. Never
 * throws: every I/O path is wrapped and resolves an `OpenPrResult`.
 */
export function createOpenPrAdapter(scriptRelPath: string = ADAPTER_REL_PATH): OpenPrAdapter {
  return async (params: OpenPrParams): Promise<OpenPrResult> => {
    const scriptPath = join(params.projectPath, scriptRelPath);
    const body = composeBody(params);
    const args = buildArgs(scriptPath, params, body);

    try {
      const { stdout } = await execFileAsync('bash', args, {
        cwd: params.projectPath,
        timeout: OPEN_PR_TIMEOUT_MS,
        maxBuffer: OPEN_PR_MAX_BUFFER_BYTES,
      });
      const url = stdout.trim();
      if (url.length === 0) {
        return { ok: false, error: 'open-pr.sh exited 0 but produced no PR URL' };
      }
      return { ok: true, url };
    } catch (error) {
      if (isSpawnEnoent(error)) {
        // `bash` itself could not be spawned.
        return { ok: false, error: `bash not found — cannot run open-pr.sh at ${scriptPath}` };
      }
      if ((error as { code?: unknown }).code === 127) {
        // bash ran but the script is missing / not executable (the codePlatform:none case).
        return { ok: false, error: `open-pr.sh not found or not executable at ${scriptPath}` };
      }
      return { ok: false, error: errorMessage(error) };
    }
  };
}

/** The real-shell default open-PR adapter. */
export const defaultOpenPr: OpenPrAdapter = createOpenPrAdapter();
