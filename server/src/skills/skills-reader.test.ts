// Unit tests for the best-effort skills reader.
//
// Each test builds a fixture project directory under os.tmpdir(), unique per
// test via crypto.randomUUID(), and tears it down in afterEach. The reader is
// best-effort: it returns a frozen SkillsState and NEVER throws.

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readSkills } from './skills-reader.js';

// Root tmp dirs created during a test, cleaned up recursively in afterEach.
const createdRoots: string[] = [];

function newTmpRoot(prefix: string): string {
  const root = join(tmpdir(), `devos-skillsreadertest-${prefix}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  createdRoots.push(root);
  return root;
}

function writeSkill(projectPath: string, dirName: string, contents: string): void {
  const dir = join(projectPath, '.claude', 'skills', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), contents);
}

function writeManifest(projectPath: string, body: string): void {
  mkdirSync(join(projectPath, '.claude'), { recursive: true });
  writeFileSync(join(projectPath, '.claude', '.harness-manifest.json'), body);
}

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`;
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('readSkills', () => {
  it('(AC2) splits org vs local skills using the manifest installedFiles, parsing name/description', () => {
    // Given: two skills on disk and a manifest that installs only "alpha"
    const dir = newTmpRoot('org-local-split');
    writeSkill(dir, 'alpha', skillMd('alpha', 'Alpha skill description'));
    writeSkill(dir, 'beta', skillMd('beta', 'Beta skill description'));
    writeManifest(
      dir,
      JSON.stringify({ installedFiles: ['skills/alpha/SKILL.md', 'other/file.txt'] }),
    );

    // When: reading skills state
    const result = readSkills(dir);

    // Then: both skills are present, correctly scoped and parsed
    expect(result.path).toBe(dir);
    expect(result.skills).toHaveLength(2);

    const alpha = result.skills.find((s) => s.name === 'alpha');
    const beta = result.skills.find((s) => s.name === 'beta');

    expect(alpha).toBeDefined();
    expect(alpha?.scope).toBe('org');
    expect(alpha?.description).toBe('Alpha skill description');

    expect(beta).toBeDefined();
    expect(beta?.scope).toBe('local');
    expect(beta?.description).toBe('Beta skill description');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.skills)).toBe(true);
  });

  it('(AC2 — regression) classifies by manifest PATH, not frontmatter name, when a skill dir differs from its name', () => {
    // Given: a skill whose directory (ralph-prd) differs from its frontmatter name (prd),
    // installed via its DIRECTORY path in the manifest. This is real DevOS data — a
    // name-based match would misclassify this installed org skill as local.
    const dir = newTmpRoot('name-dir-divergence');
    writeSkill(dir, 'ralph-prd', skillMd('prd', 'Generate a PRD'));
    writeManifest(dir, JSON.stringify({ installedFiles: ['skills/ralph-prd/SKILL.md'] }));

    const result = readSkills(dir);

    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0];
    // Display name comes from frontmatter; scope comes from the directory path.
    expect(skill?.name).toBe('prd');
    expect(skill?.scope).toBe('org');
  });

  it('(AC2 — regression) discovers and org-classifies NESTED grouped skills; does not emit the container', () => {
    // Given: a grouped skill layout — the `frontend-design` container has NO direct
    // SKILL.md, only a nested `frontend-design/design/SKILL.md` that the manifest installs.
    const dir = newTmpRoot('nested-org');
    writeSkill(dir, join('frontend-design', 'design'), skillMd('design', 'Design system skill'));
    writeSkill(dir, 'architect', skillMd('architect', 'Architecture skill'));
    writeManifest(
      dir,
      JSON.stringify({
        installedFiles: ['skills/frontend-design/design/SKILL.md', 'skills/architect/SKILL.md'],
      }),
    );

    const result = readSkills(dir);

    // The nested skill is discovered and org-classified; the container is NOT a phantom skill.
    const design = result.skills.find((s) => s.name === 'design');
    const architect = result.skills.find((s) => s.name === 'architect');
    const container = result.skills.find((s) => s.name === 'frontend-design');

    expect(design).toBeDefined();
    expect(design?.scope).toBe('org');
    expect(architect?.scope).toBe('org');
    expect(container).toBeUndefined();
    expect(result.skills).toHaveLength(2);
  });

  it('(AC4a) returns a frozen empty result when the skills dir is missing, never throws', () => {
    // Given: a project dir with no .claude/skills directory at all
    const dir = newTmpRoot('missing-skills-dir');

    // When/Then: reading never throws
    expect(() => readSkills(dir)).not.toThrow();

    const result = readSkills(dir);
    expect(result.path).toBe(dir);
    expect(result.skills).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('(AC4b) falls back to the directory name and empty description for malformed/absent frontmatter', () => {
    // Given: one skill with no frontmatter fence at all, one with a fence but no `name:`
    const dir = newTmpRoot('malformed-frontmatter');
    writeSkill(dir, 'no-fence', 'Just plain body text, no frontmatter at all.\n');
    writeSkill(dir, 'no-name', '---\ndescription: has description but no name\n---\n\nBody.\n');
    writeManifest(dir, JSON.stringify({ installedFiles: [] }));

    // When/Then: reading never throws
    expect(() => readSkills(dir)).not.toThrow();

    const result = readSkills(dir);
    expect(result.skills).toHaveLength(2);

    const noFence = result.skills.find((s) => s.name === 'no-fence');
    expect(noFence).toBeDefined();
    expect(noFence?.description).toBe('');

    const noName = result.skills.find((s) => s.name === 'no-name');
    expect(noName).toBeDefined();
    expect(noName?.description).toBe('has description but no name');
  });

  it('(AC4c) classifies every skill "local" when the manifest is missing entirely, never throws', () => {
    // Given: skills present on disk but no manifest file
    const dir = newTmpRoot('missing-manifest');
    writeSkill(dir, 'alpha', skillMd('alpha', 'Alpha'));
    writeSkill(dir, 'beta', skillMd('beta', 'Beta'));

    // When/Then: reading never throws
    expect(() => readSkills(dir)).not.toThrow();

    const result = readSkills(dir);
    expect(result.skills).toHaveLength(2);
    expect(result.skills.every((s) => s.scope === 'local')).toBe(true);
  });

  it('(AC4d) classifies every skill "local" when the manifest is malformed JSON, never throws', () => {
    // Given: skills present on disk and a manifest file that isn't valid JSON
    const dir = newTmpRoot('malformed-manifest');
    writeSkill(dir, 'alpha', skillMd('alpha', 'Alpha'));
    writeManifest(dir, '{ this is not valid json');

    // When/Then: reading never throws
    expect(() => readSkills(dir)).not.toThrow();

    const result = readSkills(dir);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.scope).toBe('local');
  });
});
