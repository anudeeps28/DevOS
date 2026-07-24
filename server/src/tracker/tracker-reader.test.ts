// Unit tests for the best-effort tracker state reader.
//
// Each test builds a REAL tmp project fixture under os.tmpdir(), unique per test
// via crypto.randomUUID(), and tears it down in afterEach. A fixture is a plain
// directory carrying a `.claude/.harness-manifest.json` and (optionally) an
// executable `.claude/trackers/active/get-sprint-issues.sh` adapter script written
// via fs + chmod 0o755. No live tracker is involved — the "adapter" is a stub shell
// script that echoes a known payload, exits non-zero, sleeps, or prints garbage.
//
// The reader is best-effort and never throws: it returns a frozen TrackerState on
// every path, collapsing any failure (missing script, non-zero exit, timeout,
// malformed output) to the "unreachable" shape.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readTrackerState } from './tracker-reader.js';

// Root tmp dirs created during a test, cleaned up recursively in afterEach.
const createdRoots: string[] = [];

const MANIFEST_REL = join('.claude', '.harness-manifest.json');
const ADAPTER_REL = join('.claude', 'trackers', 'active', 'get-sprint-issues.sh');

/** Create a fresh unique tmp project root and register it for teardown. */
async function newTmpProject(prefix: string): Promise<string> {
  const root = join(tmpdir(), `devos-trackerreadertest-${prefix}-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  createdRoots.push(root);
  return root;
}

/** Write `<root>/.claude/.harness-manifest.json` with the given tracker field. */
async function writeManifest(root: string, tracker: string): Promise<void> {
  const manifestPath = join(root, MANIFEST_REL);
  await fs.mkdir(join(root, '.claude'), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify({ tracker }), 'utf8');
}

/**
 * Write an executable `.claude/trackers/active/get-sprint-issues.sh` adapter whose
 * body is `body` (a bash snippet). chmod 0o755 so the reader can `bash` it.
 */
async function writeAdapter(root: string, body: string): Promise<void> {
  const scriptPath = join(root, ADAPTER_REL);
  await fs.mkdir(join(root, '.claude', 'trackers', 'active'), { recursive: true });
  await fs.writeFile(scriptPath, `#!/bin/bash\n${body}\n`, 'utf8');
  await fs.chmod(scriptPath, 0o755);
}

/** A known Todoist payload whose top open non-milestone item is task 202 (p1). */
const TODOIST_PAYLOAD = JSON.stringify([
  { id: 101, content: 'Low priority task', priority: 1 },
  { id: 202, content: 'Top priority task', priority: 4, url: 'https://todoist.com/task/202' },
  { id: 303, content: 'Milestone container', priority: 4, isUncompletable: true },
]);

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('readTrackerState', () => {
  it('(AC1) reports reachable:true with the top open item for a healthy todoist adapter', async () => {
    // Given: a project whose manifest is todoist and whose adapter echoes a known array
    const dir = await newTmpProject('healthy');
    await writeManifest(dir, 'todoist');
    // Single-quoted heredoc keeps the JSON verbatim (no shell interpolation).
    await writeAdapter(dir, `cat <<'JSON'\n${TODOIST_PAYLOAD}\nJSON`);

    // When: reading its tracker state
    const state = await readTrackerState(dir);

    // Then: reachable, tracker echoed, nextTask == highest-priority non-milestone item
    expect(state.reachable).toBe(true);
    expect(state.tracker).toBe('todoist');
    expect(state.nextTask).not.toBeNull();
    expect(state.nextTask?.id).toBe('202');
    expect(state.nextTask?.title).toBe('Top priority task');
    expect(state.nextTask?.priority).toBe(4);
    expect(state.path).toBe(dir);
  });

  it('(AC2) reports reachable:false with nextTask:null when the adapter exits non-zero (never throws)', async () => {
    // Given: a project whose adapter exits 1
    const dir = await newTmpProject('exit1');
    await writeManifest(dir, 'todoist');
    await writeAdapter(dir, 'echo "boom" >&2\nexit 1');

    // When/Then: the call resolves rather than rejecting
    const state = await readTrackerState(dir);
    expect(state.reachable).toBe(false);
    expect(state.nextTask).toBeNull();
    // tracker is still carried through from the manifest so the UI can label the card
    expect(state.tracker).toBe('todoist');
  });

  it('reports reachable:false when there is NO adapter script', async () => {
    // Given: a project with a manifest but no adapter script at all
    const dir = await newTmpProject('noscript');
    await writeManifest(dir, 'todoist');

    // When: reading its tracker state
    const state = await readTrackerState(dir);

    // Then: unreachable, but the manifest tracker is still surfaced
    expect(state.reachable).toBe(false);
    expect(state.nextTask).toBeNull();
    expect(state.tracker).toBe('todoist');
  });

  it('reports tracker:null when the manifest is missing entirely', async () => {
    // Given: an empty project dir — no manifest, no adapter
    const dir = await newTmpProject('nomanifest');

    // When: reading its tracker state
    const state = await readTrackerState(dir);

    // Then: unreachable with a null tracker (nothing to label the card with)
    expect(state.reachable).toBe(false);
    expect(state.tracker).toBeNull();
    expect(state.nextTask).toBeNull();
  });

  it('reports reachable:false when the adapter sleeps beyond the reader timeout (resolves, never hangs)', async () => {
    // Given: a project whose adapter sleeps 6s — just over the reader's 5s hard cap.
    const dir = await newTmpProject('timeout');
    await writeManifest(dir, 'todoist');
    await writeAdapter(dir, 'sleep 6\necho "[]"');

    // When: reading its tracker state (generous test timeout so we're asserting the
    // reader's OWN timeout, not vitest's — the point is that it RESOLVES).
    const state = await readTrackerState(dir);

    // Then: the reader gave up and reported unreachable rather than hanging
    expect(state.reachable).toBe(false);
    expect(state.nextTask).toBeNull();
  }, 15000);

  it('reports reachable:true with nextTask:null when the adapter prints malformed output (ran but unparseable)', async () => {
    // Given: the adapter runs successfully but prints non-JSON garbage.
    // The reader treats a ran-but-unparseable adapter as reachable; the quarantined
    // normalizer collapses the unparseable stdout to a null nextTask.
    const dir = await newTmpProject('malformed');
    await writeManifest(dir, 'todoist');
    await writeAdapter(dir, 'echo "this is not json"');

    // When: reading its tracker state
    const state = await readTrackerState(dir);

    // Then: reachable (the adapter exited 0) but no task could be normalized
    expect(state.reachable).toBe(true);
    expect(state.tracker).toBe('todoist');
    expect(state.nextTask).toBeNull();
  });

  it('reports reachable:true with nextTask:null when the adapter prints EMPTY output', async () => {
    // Given: the adapter exits 0 but writes nothing to stdout
    const dir = await newTmpProject('empty');
    await writeManifest(dir, 'todoist');
    await writeAdapter(dir, 'true');

    // When: reading its tracker state
    const state = await readTrackerState(dir);

    // Then: reachable, but empty stdout normalizes to no task
    expect(state.reachable).toBe(true);
    expect(state.nextTask).toBeNull();
  });

  it('returns a frozen TrackerState on the healthy path', async () => {
    const dir = await newTmpProject('frozen-ok');
    await writeManifest(dir, 'todoist');
    await writeAdapter(dir, `cat <<'JSON'\n${TODOIST_PAYLOAD}\nJSON`);

    const state = await readTrackerState(dir);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('returns a frozen TrackerState on the unreachable path', async () => {
    const dir = await newTmpProject('frozen-fail');
    await writeManifest(dir, 'todoist');
    await writeAdapter(dir, 'exit 1');

    const state = await readTrackerState(dir);
    expect(Object.isFrozen(state)).toBe(true);
  });
});
