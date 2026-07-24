import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { readStoryStates } from './story-state-reader.js';

// Each test builds a throwaway project dir under the OS tmpdir and tears it down.
const created: string[] = [];

async function makeProject(): Promise<string> {
  const root = join(tmpdir(), `story-state-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  created.push(root);
  return root;
}

async function makeStory(root: string, id: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, 'tasks', 'stories', id);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(dir, name), content, 'utf8');
  }
}

afterEach(async () => {
  await Promise.all(created.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  created.length = 0;
});

describe('readStoryStates', () => {
  it('returns hasStartedStory:false and never throws when tasks/stories is missing', async () => {
    const root = await makeProject();
    const summary = await readStoryStates(root);
    expect(summary.hasStartedStory).toBe(false);
  });

  it('does not count a story folder holding only brief.md as started', async () => {
    const root = await makeProject();
    await makeStory(root, 'S1', { 'brief.md': '# Brief\nsome context' });
    const summary = await readStoryStates(root);
    expect(summary.hasStartedStory).toBe(false);
  });

  it('does not count an executor-state.md without a Progress section as started', async () => {
    const root = await makeProject();
    await makeStory(root, 'S1', { 'executor-state.md': '# Executor State\n\nno progress yet' });
    const summary = await readStoryStates(root);
    expect(summary.hasStartedStory).toBe(false);
  });

  it('counts an executor-state.md WITH a Progress section as started', async () => {
    const root = await makeProject();
    await makeStory(root, 'S1', {
      'executor-state.md': '# Executor State\n\n## Progress\n\n| Task | Result |\n',
    });
    const summary = await readStoryStates(root);
    expect(summary.hasStartedStory).toBe(true);
  });

  it('counts a started story even when a sibling empty story exists', async () => {
    const root = await makeProject();
    await makeStory(root, 'S1', { 'brief.md': '# Brief' });
    await makeStory(root, 'S2', { 'executor-state.md': '## Progress\ndone' });
    const summary = await readStoryStates(root);
    expect(summary.hasStartedStory).toBe(true);
  });

  it('returns a frozen summary', async () => {
    const root = await makeProject();
    const summary = await readStoryStates(root);
    expect(Object.isFrozen(summary)).toBe(true);
  });
});
