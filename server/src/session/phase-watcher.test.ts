import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createPhaseWatcher, type PhaseTransitionSignal } from './phase-watcher.js';

// Each test builds a throwaway project dir under the OS tmpdir and tears it down,
// mirroring story-state-reader.test.ts. These tests exercise the REAL fs.watch-backed
// createPhaseWatcher (the plan-gate "builder finished planning" seam), not a fake.
const created: string[] = [];
const watchers: Array<{ stopAll: () => void }> = [];

async function makeStoryDir(workItemId: string): Promise<string> {
  const root = join(tmpdir(), `phase-watcher-${randomUUID()}`);
  await fs.mkdir(join(root, 'tasks', 'stories', workItemId), { recursive: true });
  created.push(root);
  return root;
}

function marker(phase: string): string {
  return [
    'schemaVersion: 1',
    `phase: ${phase}`,
    'role: builder',
    'updated: 2026-08-03T00:00:00Z',
    'skill: implement',
    'detail: test',
  ].join('\n');
}

async function writePhase(root: string, workItemId: string, phase: string): Promise<void> {
  await fs.writeFile(join(root, 'tasks', 'stories', workItemId, 'phase.md'), marker(phase), 'utf8');
}

/** Poll until `predicate` holds or the timeout elapses — fs.watch fires asynchronously. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const w of watchers) w.stopAll();
  watchers.length = 0;
  await Promise.all(created.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  created.length = 0;
});

describe('createPhaseWatcher', () => {
  it('emits a transition signal when phase.md changes to a new phase', async () => {
    const workItemId = 'story-1';
    const root = await makeStoryDir(workItemId);
    await writePhase(root, workItemId, 'planning');

    const pw = createPhaseWatcher();
    watchers.push(pw);
    const signals: PhaseTransitionSignal[] = [];
    pw.onPhaseTransition((s) => signals.push(s));
    pw.watch({ sessionId: 's1', projectPath: root, workItemId });

    await writePhase(root, workItemId, 'coding');
    await waitFor(() => signals.length >= 1);

    expect(signals.length).toBe(1);
    expect(signals[0]).toMatchObject({ sessionId: 's1', projectPath: root, workItemId, phase: 'coding' });
    expect(Object.isFrozen(signals[0])).toBe(true);
  });

  it('dedupes: writing the SAME phase again emits nothing', async () => {
    const workItemId = 'story-2';
    const root = await makeStoryDir(workItemId);
    await writePhase(root, workItemId, 'planning');

    const pw = createPhaseWatcher();
    watchers.push(pw);
    const signals: PhaseTransitionSignal[] = [];
    pw.onPhaseTransition((s) => signals.push(s));
    pw.watch({ sessionId: 's2', projectPath: root, workItemId });

    await writePhase(root, workItemId, 'coding');
    await waitFor(() => signals.length >= 1);
    await writePhase(root, workItemId, 'coding'); // same phase — must not re-emit
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(signals.length).toBe(1);
  });

  it('emits again on a genuinely new phase (coding → testing)', async () => {
    const workItemId = 'story-3';
    const root = await makeStoryDir(workItemId);
    await writePhase(root, workItemId, 'planning');

    const pw = createPhaseWatcher();
    watchers.push(pw);
    const signals: PhaseTransitionSignal[] = [];
    pw.onPhaseTransition((s) => signals.push(s));
    pw.watch({ sessionId: 's3', projectPath: root, workItemId });

    await writePhase(root, workItemId, 'coding');
    await waitFor(() => signals.length >= 1);
    await writePhase(root, workItemId, 'testing');
    await waitFor(() => signals.length >= 2);

    expect(signals.map((s) => s.phase)).toEqual(['coding', 'testing']);
  });

  it('stops emitting after unwatch', async () => {
    const workItemId = 'story-4';
    const root = await makeStoryDir(workItemId);
    await writePhase(root, workItemId, 'planning');

    const pw = createPhaseWatcher();
    watchers.push(pw);
    const signals: PhaseTransitionSignal[] = [];
    pw.onPhaseTransition((s) => signals.push(s));
    pw.watch({ sessionId: 's4', projectPath: root, workItemId });

    await writePhase(root, workItemId, 'coding');
    await waitFor(() => signals.length >= 1);
    pw.unwatch('s4');

    await writePhase(root, workItemId, 'testing'); // after unwatch — must not emit
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(signals.length).toBe(1);
  });

  it('an unsubscribed listener receives no further signals', async () => {
    const workItemId = 'story-5';
    const root = await makeStoryDir(workItemId);
    await writePhase(root, workItemId, 'planning');

    const pw = createPhaseWatcher();
    watchers.push(pw);
    const signals: PhaseTransitionSignal[] = [];
    const unsubscribe = pw.onPhaseTransition((s) => signals.push(s));
    pw.watch({ sessionId: 's5', projectPath: root, workItemId });

    unsubscribe();
    await writePhase(root, workItemId, 'coding');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(signals.length).toBe(0);
  });

  it('never throws and emits nothing for a malformed marker', async () => {
    const workItemId = 'story-6';
    const root = await makeStoryDir(workItemId);
    await writePhase(root, workItemId, 'planning');

    const pw = createPhaseWatcher();
    watchers.push(pw);
    const signals: PhaseTransitionSignal[] = [];
    pw.onPhaseTransition((s) => signals.push(s));
    pw.watch({ sessionId: 's6', projectPath: root, workItemId });

    // Unparseable marker (bad schemaVersion) → parsePhaseMarker returns null → no signal.
    await fs.writeFile(
      join(root, 'tasks', 'stories', workItemId, 'phase.md'),
      'schemaVersion: 99\nphase: coding\n',
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(signals.length).toBe(0);
  });

  it('unwatch is a guarded no-op for an unknown session', () => {
    const pw = createPhaseWatcher();
    watchers.push(pw);
    expect(() => pw.unwatch('never-watched')).not.toThrow();
  });

  it('stopAll tears down all watchers so no further signals fire', async () => {
    const workItemId = 'story-7';
    const root = await makeStoryDir(workItemId);
    await writePhase(root, workItemId, 'planning');

    const pw = createPhaseWatcher();
    const signals: PhaseTransitionSignal[] = [];
    pw.onPhaseTransition((s) => signals.push(s));
    pw.watch({ sessionId: 's7', projectPath: root, workItemId });

    pw.stopAll();
    await writePhase(root, workItemId, 'coding');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(signals.length).toBe(0);
  });
});
