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
  schemaVersion: 1,
  pipeline: ['navigator', 'shipwright', 'lookout', 'warden', 'harbormaster'],
  roles: {
    navigator: {
      displayName: 'Navigator',
      stages: ['decide', 'define'],
      skills: ['grill-me'],
      agent: 'navigator',
      producesArtifacts: ['grill-summary.md'],
    },
    shipwright: {
      displayName: 'Shipwright',
      stages: ['build'],
      skills: ['implement'],
      agent: 'shipwright',
      producesArtifacts: ['code + unit tests'],
    },
    lookout: {
      displayName: 'Lookout',
      stages: ['test'],
      skills: ['tdd'],
      agent: 'lookout',
      producesArtifacts: ['test results'],
    },
    warden: {
      displayName: 'Warden',
      stages: ['review'],
      skills: ['evaluate'],
      agent: 'warden',
      producesArtifacts: ['tasks/stories/<id>/evaluation.md'],
    },
    harbormaster: {
      displayName: 'Harbormaster',
      stages: ['ship'],
      skills: ['deploy'],
      agent: 'harbormaster',
      producesArtifacts: ['PR'],
    },
  },
});

describe('readRoster', () => {
  it('parses the real repo roster to the expected 5-role pipeline', () => {
    const roster = readRoster(REPO_ROOT);
    expect(roster).not.toBeNull();
    expect(roster?.schemaVersion).toBe(1);
    expect(roster?.pipeline).toEqual([
      'navigator',
      'shipwright',
      'lookout',
      'warden',
      'harbormaster',
    ]);
    expect(Object.keys(roster?.roles ?? {})).toEqual([
      'navigator',
      'shipwright',
      'lookout',
      'warden',
      'harbormaster',
    ]);
    expect(roster?.roles.navigator.displayName).toBe('Navigator');
    expect(Object.isFrozen(roster)).toBe(true);
    expect(Object.isFrozen(roster?.pipeline)).toBe(true);
    expect(Object.isFrozen(roster?.roles)).toBe(true);
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
    const malformed = { ...raw, pipeline: [...raw.pipeline, 'captain'] };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when schemaVersion does not match', () => {
    const raw = JSON.parse(VALID_ROSTER) as Record<string, unknown>;
    const malformed = { ...raw, schemaVersion: 2 };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });

  it('returns null when a pipeline role is missing from roles', () => {
    const raw = JSON.parse(VALID_ROSTER) as { roles: Record<string, unknown> };
    const { harbormaster: _harbormaster, ...rest } = raw.roles;
    const malformed = { ...JSON.parse(VALID_ROSTER), roles: rest };
    const dir = makeProjectWithRoster(JSON.stringify(malformed));
    expect(readRoster(dir)).toBeNull();
  });
});
