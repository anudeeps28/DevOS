// Unit tests — role roster reader.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readRoster } from './roster-reader.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

let tmpDir: string | null = null;

/** Create a fresh tmp project dir with `.claude/harness-roles.json` = `contents`. */
function makeProjectWithRoster(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'devos-roster-reader-'));
  tmpDir = dir;
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'harness-roles.json'), contents, 'utf8');
  return dir;
}

afterEach(() => {
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

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
      producesArtifacts: [
        'tasks/stories/<id>/plan.md',
        'tasks/stories/<id>/phase.md',
        'code + unit tests',
        'pushed branch + drafted PR body',
      ],
    },
    reviewer: {
      displayName: 'Reviewer',
      skills: ['evaluate'],
      agent: 'reviewer',
      phases: [{ id: 'reviewing', displayName: 'Warden' }],
      model: 'claude-opus-5[1m]',
      effort: 'high',
      producesArtifacts: [
        'tasks/stories/<id>/phase.md',
        'tasks/stories/<id>/evaluation.md',
        'tasks/stories/<id>/acceptance.md',
        'tasks/stories/<id>/architecture-review.md',
        'tasks/stories/<id>/security-review.md',
      ],
    },
  },
});

describe('readRoster', () => {
  it('parses the real repo roster to the expected 2-role pipeline', () => {
    const roster = readRoster(REPO_ROOT);
    expect(roster).not.toBeNull();
    expect(roster?.schemaVersion).toBe(2);
    expect(roster?.pipeline).toEqual(['builder', 'reviewer']);
    expect(Object.keys(roster?.roles ?? {})).toEqual(['builder', 'reviewer']);
    expect(roster?.roles.builder.displayName).toBe('Builder');
    expect(roster?.roles.builder.model).toBe('claude-opus-5[1m]');
    expect(roster?.roles.builder.effort).toBe('medium');
    expect(roster?.roles.builder.phases).toEqual([
      { id: 'planning', displayName: 'Navigator' },
      { id: 'coding', displayName: 'Shipwright' },
      { id: 'testing', displayName: 'Lookout' },
      { id: 'shipping', displayName: 'Harbormaster' },
    ]);
    expect(roster?.roles.reviewer.model).toBe('claude-opus-5[1m]');
    expect(roster?.roles.reviewer.effort).toBe('high');
    expect(roster?.roles.reviewer.phases).toEqual([{ id: 'reviewing', displayName: 'Warden' }]);
    expect(roster?.roles.builder.contextWindow).toBe(1_000_000);
    expect(roster?.roles.reviewer.contextWindow).toBe(1_000_000);
    expect(Object.isFrozen(roster)).toBe(true);
    expect(Object.isFrozen(roster?.pipeline)).toBe(true);
    expect(Object.isFrozen(roster?.roles)).toBe(true);
    expect(Object.isFrozen(roster?.roles.builder)).toBe(true);
  });

  it('parses a valid v2 roster fixture to a frozen Roster', () => {
    const dir = makeProjectWithRoster(VALID_ROSTER);
    const roster = readRoster(dir);
    expect(roster).not.toBeNull();
    expect(roster?.schemaVersion).toBe(2);
    expect(roster?.pipeline).toEqual(['builder', 'reviewer']);
    expect(Object.isFrozen(roster)).toBe(true);
    expect(Object.isFrozen(roster?.roles.builder)).toBe(true);
  });

  it('keeps a valid contextWindow and leaves it undefined when absent (additive, backward-compatible)', () => {
    const raw = JSON.parse(VALID_ROSTER) as { roles: Record<string, Record<string, unknown>> };
    const withWindow = {
      ...raw,
      roles: {
        ...raw.roles,
        builder: { ...raw.roles.builder, contextWindow: 1_000_000 },
        // reviewer intentionally has no contextWindow — the old shape must still parse.
      },
    };
    const roster = readRoster(makeProjectWithRoster(JSON.stringify(withWindow)));
    expect(roster?.roles.builder.contextWindow).toBe(1_000_000);
    expect(roster?.roles.reviewer.contextWindow).toBeUndefined();
  });

  it('drops an invalid contextWindow (non-positive, non-finite, or non-number) rather than failing', () => {
    const raw = JSON.parse(VALID_ROSTER) as { roles: Record<string, Record<string, unknown>> };
    for (const bad of [0, -1, 'lots', null]) {
      const malformed = {
        ...raw,
        roles: { ...raw.roles, builder: { ...raw.roles.builder, contextWindow: bad } },
      };
      const roster = readRoster(makeProjectWithRoster(JSON.stringify(malformed)));
      // The role still parses (drop-don't-throw); the bad window is simply dropped.
      expect(roster).not.toBeNull();
      expect(roster?.roles.builder.contextWindow).toBeUndefined();
    }
  });

  it('returns null when the roster file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devos-roster-reader-'));
    tmpDir = dir;
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const dir = makeProjectWithRoster('{ this is not valid json ');
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when the pipeline contains an unknown role', () => {
    const raw = JSON.parse(VALID_ROSTER) as { pipeline: string[] };
    const malformed = { ...raw, pipeline: [...raw.pipeline, 'shipwright'] };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when schemaVersion is 1 (old roster)', () => {
    const raw = JSON.parse(VALID_ROSTER) as Record<string, unknown>;
    const malformed = { ...raw, schemaVersion: 1 };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when a pipeline role is missing from roles', () => {
    const raw = JSON.parse(VALID_ROSTER) as { roles: Record<string, unknown> };
    const { reviewer: _reviewer, ...rest } = raw.roles;
    const malformed = { ...JSON.parse(VALID_ROSTER), roles: rest };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when a role-def is missing model', () => {
    const raw = JSON.parse(VALID_ROSTER) as { roles: { builder: Record<string, unknown> } };
    const { model: _model, ...rest } = raw.roles.builder;
    const malformed = {
      ...raw,
      roles: { ...raw.roles, builder: rest },
    };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when a role-def is missing effort', () => {
    const raw = JSON.parse(VALID_ROSTER) as { roles: { builder: Record<string, unknown> } };
    const { effort: _effort, ...rest } = raw.roles.builder;
    const malformed = {
      ...raw,
      roles: { ...raw.roles, builder: rest },
    };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when a role-def has a malformed phases entry', () => {
    const raw = JSON.parse(VALID_ROSTER) as { roles: Record<string, Record<string, unknown>> };
    const malformed = {
      ...raw,
      roles: {
        ...raw.roles,
        builder: { ...raw.roles.builder, phases: [{ id: 'planning' }] },
      },
    };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when a role-def has a bad effort value', () => {
    const raw = JSON.parse(VALID_ROSTER) as { roles: Record<string, Record<string, unknown>> };
    const malformed = {
      ...raw,
      roles: {
        ...raw.roles,
        builder: { ...raw.roles.builder, effort: 'ultra' },
      },
    };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });
});
