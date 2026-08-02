// Best-effort skills reader for a project's `.claude/skills` directory.
//
// Mirrors the codebase's "drop, don't throw / frozen-return" boundary-reader template
// (see ../session/roster-reader.ts, ../git/git-state-reader.ts): the whole
// scan+parse+classify pipeline is defensive. Any problem — missing skills dir,
// missing/malformed manifest, missing/malformed SKILL.md frontmatter — yields a
// best-effort result rather than throwing. readSkills NEVER throws.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Skill, SkillsState } from '../ws-protocol.js';

const SKILLS_REL_PATH = join('.claude', 'skills');
const MANIFEST_REL_PATH = join('.claude', '.harness-manifest.json');

// A manifest `installedFiles` entry that names an installed (org) skill. Nesting is
// allowed: skills live at `skills/<name>/SKILL.md` AND, for grouped skills, at
// `skills/<group>/<name>/SKILL.md` (e.g. `skills/frontend-design/design/SKILL.md`).
// Classification keys on this FULL relative path, never on the skill's display name —
// a skill's frontmatter `name` can differ from its directory (e.g. dir `ralph-prd`,
// name `prd`), so a name-based match would misclassify installed skills as local.
const ORG_SKILL_ENTRY_PATTERN = /^skills\/.+\/SKILL\.md$/;

// Bounds on the recursive scan of an untrusted pinned repo's skills tree: cap the
// total skills listed and the recursion depth so a pathological tree can't blow up
// the synchronous read. Today's real trees are ~39 skills, 2 levels deep.
const MAX_SKILLS = 500;
const MAX_DEPTH = 8;

/** The frozen empty shape returned whenever the skills dir can't be read at all. */
function empty(projectPath: string): SkillsState {
  return Object.freeze<SkillsState>({ path: projectPath, skills: [] });
}

// The manifest is either present for the whole process lifetime or not, so warn at
// most once — a per-render reader would otherwise flood the log on every read.
let warnedManifestUnavailable = false;

/**
 * Load the set of org (manifest-installed) skill paths from
 * `<projectPath>/.claude/.harness-manifest.json`. Each element is the manifest-
 * relative POSIX path of an installed `SKILL.md` (e.g. `skills/ralph-prd/SKILL.md`,
 * `skills/frontend-design/design/SKILL.md`). Best-effort: any failure — missing file,
 * malformed JSON, missing/malformed `installedFiles` — yields an EMPTY set with
 * `available: false` (fail-closed: every skill then classifies 'local'). NEVER throws.
 */
function loadOrgSkillPaths(projectPath: string): { paths: Set<string>; available: boolean } {
  try {
    const raw = readFileSync(join(projectPath, MANIFEST_REL_PATH), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { paths: new Set(), available: false };

    const { installedFiles } = parsed as Record<string, unknown>;
    if (!Array.isArray(installedFiles)) return { paths: new Set(), available: false };

    const paths = new Set<string>();
    for (const entry of installedFiles) {
      if (typeof entry !== 'string') continue;
      if (ORG_SKILL_ENTRY_PATTERN.test(entry)) paths.add(entry);
    }
    return { paths, available: true };
  } catch {
    return { paths: new Set(), available: false };
  }
}

/** Strip a leading/trailing matching quote (single or double) if present. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Read the first `key: value` line's value out of a frontmatter block, or null. */
function readFrontmatterField(block: string, key: string): string | null {
  for (const line of block.split('\n')) {
    const prefix = `${key}:`;
    if (line.startsWith(prefix)) {
      const value = stripQuotes(line.slice(prefix.length).trim());
      return value;
    }
  }
  return null;
}

/**
 * Hand-parse a `SKILL.md`'s YAML-ish frontmatter (no yaml dependency): if the file
 * starts with a `---` fence, extract `name:`/`description:` from the block up to
 * the next `---`. Missing/blank `name` falls back to `dirName`; missing
 * `description` falls back to `''`. Malformed/absent frontmatter never throws —
 * it just yields the fallback values.
 */
function parseSkillMd(contents: string, dirName: string): { name: string; description: string } {
  const fallback = { name: dirName, description: '' };

  if (!contents.startsWith('---')) return fallback;
  const closeIndex = contents.indexOf('\n---', 3);
  if (closeIndex === -1) return fallback;

  const block = contents.slice(3, closeIndex);
  const rawName = readFrontmatterField(block, 'name');
  const rawDescription = readFrontmatterField(block, 'description');

  const name = rawName !== null && rawName.length > 0 ? rawName : dirName;
  const description = rawDescription ?? '';

  return { name, description };
}

/**
 * Read one skill's `SKILL.md` and classify it. `relKey` is the manifest-relative
 * POSIX path (`skills/<...>/SKILL.md`) used for org/local classification; `dirName`
 * is the skill's immediate directory, used as the display-name fallback. Returns null
 * if the file is absent/unreadable (never throws).
 */
function readSkillFile(absSkillMd: string, dirName: string, relKey: string, orgPaths: Set<string>): Skill | null {
  try {
    const contents = readFileSync(absSkillMd, 'utf8');
    const { name, description } = parseSkillMd(contents, dirName);
    const scope: Skill['scope'] = orgPaths.has(relKey) ? 'org' : 'local';
    return Object.freeze<Skill>({ name, description, scope });
  } catch {
    return null;
  }
}

/**
 * Recursively walk the skills tree collecting one Skill per directory that directly
 * contains a `SKILL.md`, then recursing into subdirectories to find grouped/nested
 * skills. Bounded by MAX_DEPTH and MAX_SKILLS. `readdirSync({ withFileTypes: true })`
 * reports symlinks as symlinks (not directories/files), so a symlinked directory has
 * `isDirectory() === false` and is NOT traversed — no symlink-loop / out-of-tree walk.
 */
function walkSkills(
  currentDir: string,
  relSegments: readonly string[],
  depth: number,
  orgPaths: Set<string>,
  out: Skill[],
): void {
  if (depth > MAX_DEPTH || out.length >= MAX_SKILLS) return;

  let entries;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  // A directory that directly contains a SKILL.md is itself a skill (skip the root
  // skills dir, which has no relSegments).
  if (relSegments.length > 0 && entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
    const relKey = ['skills', ...relSegments, 'SKILL.md'].join('/');
    const dirName = relSegments[relSegments.length - 1] ?? '';
    const skill = readSkillFile(join(currentDir, 'SKILL.md'), dirName, relKey, orgPaths);
    if (skill !== null) out.push(skill);
  }

  for (const entry of entries) {
    if (out.length >= MAX_SKILLS) break;
    if (!entry.isDirectory()) continue; // skips files AND symlinked dirs
    walkSkills(join(currentDir, entry.name), [...relSegments, entry.name], depth + 1, orgPaths, out);
  }
}

/**
 * Read the skills state for `projectPath`: recursively scans `.claude/skills` for every
 * `SKILL.md` (top-level `skills/<name>/SKILL.md` and grouped `skills/<group>/<name>/SKILL.md`),
 * hand-parses each file's frontmatter, and classifies each skill 'org' or 'local' by matching
 * its manifest-relative path against the project's `.claude/.harness-manifest.json` `installedFiles`.
 * Best-effort throughout: a missing skills dir yields an empty list; a missing/malformed manifest
 * yields an empty org set (every skill classifies 'local', fail-closed). Returns a frozen
 * SkillsState on every path and NEVER throws.
 */
export function readSkills(projectPath: string): SkillsState {
  try {
    const skillsDir = join(projectPath, SKILLS_REL_PATH);

    // Bail early (empty) if the skills dir itself is unreadable — matches the prior
    // "missing dir → empty" contract without recursing.
    try {
      readdirSync(skillsDir);
    } catch {
      return empty(projectPath);
    }

    const { paths: orgSkillPaths, available: manifestAvailable } = loadOrgSkillPaths(projectPath);
    if (!manifestAvailable && !warnedManifestUnavailable) {
      warnedManifestUnavailable = true;
      console.warn(
        `[skills-reader] manifest unavailable at ${projectPath} — all skills classify 'local'`,
      );
    }

    const skills: Skill[] = [];
    walkSkills(skillsDir, [], 0, orgSkillPaths, skills);

    return Object.freeze<SkillsState>({ path: projectPath, skills: Object.freeze(skills) });
  } catch {
    return empty(projectPath);
  }
}
