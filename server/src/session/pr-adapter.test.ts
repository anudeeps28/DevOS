// Unit tests for the injectable open-PR adapter seam (AC4-seam).
//
// Mirrors tracker-reader.test.ts's fixture style: each test builds a REAL tmp
// project fixture under os.tmpdir(), unique per test via crypto.randomUUID(), and
// tears it down in afterEach. No live tracker/PR platform is involved — offline
// only.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOpenPrAdapter, defaultOpenPr, type OpenPrParams } from './pr-adapter.js';

const createdRoots: string[] = [];

/** Create a fresh unique tmp project root and register it for teardown. */
async function newTmpProject(prefix: string): Promise<string> {
  const root = join(tmpdir(), `devos-pradaptertest-${prefix}-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  createdRoots.push(root);
  return root;
}

/** Write an executable fake `open-pr.sh`-shaped script at `relPath` inside `root`. */
async function writeScript(root: string, relPath: string, body: string): Promise<void> {
  const scriptPath = join(root, relPath);
  await fs.writeFile(scriptPath, `#!/bin/bash\n${body}\n`, 'utf8');
  await fs.chmod(scriptPath, 0o755);
}

const BASE_PARAMS: Omit<OpenPrParams, 'projectPath'> = {
  title: 'Add dark mode toggle',
  body: 'Implements the settings toggle described in the brief.',
  verdicts: ['CLEAR — reviewer'],
  advisories: ['Consider adding a screenshot'],
};

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('defaultOpenPr', () => {
  it('(AC4) resolves { ok:false, error } with a non-empty error when open-pr.sh does NOT exist (loud failure)', async () => {
    // Given: a project with no `.claude/code-platform/active/open-pr.sh` (codePlatform:none)
    const dir = await newTmpProject('noscript');

    // When: the default adapter is invoked
    const result = await defaultOpenPr({ ...BASE_PARAMS, projectPath: dir });

    // Then: it loudly fails — never a silent success
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('never throws or rejects on a missing script', async () => {
    const dir = await newTmpProject('neverthrows');
    await expect(defaultOpenPr({ ...BASE_PARAMS, projectPath: dir })).resolves.toBeDefined();
  });
});

describe('createOpenPrAdapter — argv safety', () => {
  it('passes the composed title/body as discrete argv elements — a bracket value survives verbatim, no shell globbing', async () => {
    // Given: a fake script that captures its own argv verbatim (no shell reinterpretation)
    const dir = await newTmpProject('argv-safety');
    const relScriptPath = 'fake-open-pr.sh';
    await writeScript(
      dir,
      relScriptPath,
      [
        'printf \'%s\\n\' "$@" > "$(dirname "$0")/argv-captured.txt"',
        'echo "https://example.invalid/pr/1"',
      ].join('\n'),
    );
    const adapter = createOpenPrAdapter(relScriptPath);

    // A title carrying glob/bracket-significant characters — must NOT be shell-interpreted.
    const bracketTitle = 'Wire model claude-opus-5[1m] into buildSessionOptions';

    // When: the adapter is invoked
    const result = await adapter({ ...BASE_PARAMS, projectPath: dir, title: bracketTitle });

    // Then: it succeeded (the fake script echoed a URL)
    expect(result.ok).toBe(true);

    // And: the captured argv contains the bracket title verbatim, on its own line —
    // proof it arrived as one argv element, not shell-glob-expanded or word-split.
    const captured = await fs.readFile(join(dir, 'argv-captured.txt'), 'utf8');
    const lines = captured.split('\n');
    expect(lines).toContain(bracketTitle);

    // And: the composed body (base body + appended verdicts/advisories section) also
    // rode through as a single argv element (its internal newlines are still present
    // in the captured file, just spread across lines — the point is it's ONE argv
    // value, unsplit by the shell/word-splitting).
    expect(captured).toContain(BASE_PARAMS.body);
    expect(captured).toContain('## Review verdicts');
    expect(captured).toContain('CLEAR — reviewer');
    expect(captured).toContain('## Advisories');
    expect(captured).toContain('Consider adding a screenshot');
  });

  it('resolves { ok:false, error } when the script exits non-zero', async () => {
    const dir = await newTmpProject('exit1');
    const relScriptPath = 'fake-open-pr.sh';
    await writeScript(dir, relScriptPath, 'echo "boom" >&2\nexit 1');
    const adapter = createOpenPrAdapter(relScriptPath);

    const result = await adapter({ ...BASE_PARAMS, projectPath: dir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
