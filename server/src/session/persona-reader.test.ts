// Unit tests — persona-join reader (roster x phase.md → SessionPersona).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionPersonas, type SessionForPersona } from './persona-reader.js';

let tmpDir: string | null = null;

const VALID_ROSTER = JSON.stringify({
  schemaVersion: 2,
  pipeline: ['builder', 'reviewer'],
  roles: {
    builder: {
      displayName: 'Builder',
      skills: ['implement', 'run-tasks'],
      agent: 'builder',
      phases: [
        { id: 'planning', displayName: 'Navigator' },
        { id: 'coding', displayName: 'Shipwright' },
        { id: 'testing', displayName: 'Lookout' },
        { id: 'shipping', displayName: 'Harbormaster' },
      ],
      model: 'claude-opus-5[1m]',
      effort: 'medium',
      producesArtifacts: [],
    },
    reviewer: {
      displayName: 'Reviewer',
      skills: ['evaluate'],
      agent: 'reviewer',
      phases: [{ id: 'reviewing', displayName: 'Warden' }],
      model: 'claude-opus-5[1m]',
      effort: 'high',
      producesArtifacts: [],
    },
  },
});

/** Create a fresh tmp project dir, optionally with `.claude/harness-roles.json`. */
function makeProject(withRoster: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'devos-persona-reader-'));
  tmpDir = dir;
  if (withRoster) {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'harness-roles.json'), VALID_ROSTER, 'utf8');
  }
  return dir;
}

/** Write a `tasks/stories/<workItemId>/phase.md` marker for `projectPath`. */
function writePhaseMarker(projectPath: string, workItemId: string, phase: string): void {
  const dir = join(projectPath, 'tasks', 'stories', workItemId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'phase.md'),
    `schemaVersion: 1\nphase: ${phase}\nrole: builder\nupdated: 2026-07-31T18:56:35Z\nskill: implement\ndetail: test\n`,
    'utf8',
  );
}

afterEach(() => {
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('readSessionPersonas', () => {
  it('joins a session against the roster and its story phase — happy path', async () => {
    const dir = makeProject(true);
    writePhaseMarker(dir, 'WI-1', 'coding');
    const sessions: readonly SessionForPersona[] = [
      { sessionId: 's-1', workItemId: 'WI-1', role: 'builder' },
    ];

    const personas = await readSessionPersonas(dir, sessions);

    expect(personas).toEqual([
      { sessionId: 's-1', workItemId: 'WI-1', role: 'builder', phase: 'coding', persona: 'Shipwright' },
    ]);
    expect(Object.isFrozen(personas)).toBe(true);
    expect(Object.isFrozen(personas[0])).toBe(true);
  });

  it('yields a null persona when phase.md is missing (never throws)', async () => {
    const dir = makeProject(true);
    const sessions: readonly SessionForPersona[] = [
      { sessionId: 's-1', workItemId: 'WI-missing', role: 'builder' },
    ];

    const personas = await readSessionPersonas(dir, sessions);

    expect(personas).toEqual([
      { sessionId: 's-1', workItemId: 'WI-missing', role: 'builder', phase: null, persona: null },
    ]);
  });

  it('yields a null persona when the roster is missing/null', async () => {
    const dir = makeProject(false);
    writePhaseMarker(dir, 'WI-1', 'coding');
    const sessions: readonly SessionForPersona[] = [
      { sessionId: 's-1', workItemId: 'WI-1', role: 'builder' },
    ];

    const personas = await readSessionPersonas(dir, sessions);

    expect(personas).toEqual([
      { sessionId: 's-1', workItemId: 'WI-1', role: 'builder', phase: 'coding', persona: null },
    ]);
  });

  it('yields a null phase/persona when workItemId is null', async () => {
    const dir = makeProject(true);
    const sessions: readonly SessionForPersona[] = [
      { sessionId: 's-1', workItemId: null, role: 'builder' },
    ];

    const personas = await readSessionPersonas(dir, sessions);

    expect(personas).toEqual([
      { sessionId: 's-1', workItemId: null, role: 'builder', phase: null, persona: null },
    ]);
  });

  it('returns an empty frozen array for no sessions', async () => {
    const dir = makeProject(true);
    const personas = await readSessionPersonas(dir, []);
    expect(personas).toEqual([]);
    expect(Object.isFrozen(personas)).toBe(true);
  });

  it('never escapes tasks/stories when a persisted workItemId is a traversal payload', async () => {
    // Defense-in-depth: even if a pre-boundary-tightening session row carries a
    // path-traversal workItemId, the reader must not read outside tasks/stories/<id>/.
    const dir = makeProject(true);
    const sessions: readonly SessionForPersona[] = [
      { sessionId: 's-1', workItemId: '../../../../../../etc', role: 'builder' },
      { sessionId: 's-2', workItemId: 'a/b', role: 'reviewer' },
    ];

    const personas = await readSessionPersonas(dir, sessions);

    expect(personas).toEqual([
      { sessionId: 's-1', workItemId: '../../../../../../etc', role: 'builder', phase: null, persona: null },
      { sessionId: 's-2', workItemId: 'a/b', role: 'reviewer', phase: null, persona: null },
    ]);
  });
});
