// Role roster reader — parses and validates the project's `.claude/harness-roles.json`
// (SPEC §3.1) into a frozen, typed Roster.
//
// Mirrors the codebase's "drop, don't throw / frozen-return" boundary-reader template
// (see ../git/git-state-reader.ts, ../tracker/tracker-reader.ts): the whole
// read+parse+validate pipeline is wrapped in a single try/catch. Any problem —
// missing file, malformed JSON, wrong schemaVersion, an empty/invalid pipeline, an
// unknown pipeline role, or a pipeline role missing its `roles.<name>` def — yields
// `null`. readRoster NEVER throws.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Role } from './roles.js';
import { isValidRole } from './roles.js';

const ROSTER_REL_PATH = join('.claude', 'harness-roles.json');

const EXPECTED_SCHEMA_VERSION = 2;

const VALID_EFFORT_NAMES: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A display phase surfaced by a role (e.g. planning → Navigator). */
export interface Phase {
  readonly id: string;
  readonly displayName: string;
}

/**
 * Effort level for a role's model. Mirrors the SDK's `EffortLevel` union by value
 * so the two agree at the `Options.effort` boundary without a cast — this reader
 * stays SDK-free and does not import the SDK type.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Definition of a single role in the roster. */
export interface RoleDef {
  readonly displayName: string;
  readonly phases: readonly Phase[];
  readonly skills: readonly string[];
  readonly agent: string;
  readonly model: string;
  readonly effort: Effort;
  /**
   * The model's context window in tokens (optional, additive). Authoritative for this role's
   * sessions — the context-recycle check sizes off it rather than guessing from the model id.
   * Omitted or invalid (non-positive / non-finite) → the reader drops it and the consumer falls
   * back to deriving the window from the model.
   */
  readonly contextWindow?: number;
  readonly producesArtifacts: readonly string[];
}

/** The full role roster: pipeline order + per-role definitions. */
export interface Roster {
  readonly schemaVersion: number;
  readonly pipeline: readonly Role[];
  readonly roles: Readonly<Record<Role, RoleDef>>;
}

/** Type guard: `value` is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type guard: `value` is a readonly array of strings. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Parse a single raw phase entry. Returns null if `id`/`displayName` are not both strings. */
function parsePhase(raw: unknown): Phase | null {
  if (!isPlainObject(raw)) return null;
  const { id, displayName } = raw;
  if (typeof id !== 'string') return null;
  if (typeof displayName !== 'string') return null;
  return Object.freeze<Phase>({ id, displayName });
}

/** Type guard: `value` is an array of well-formed Phase entries. */
function isPhaseArray(value: unknown): value is readonly Phase[] {
  return Array.isArray(value) && value.every((entry) => parsePhase(entry) !== null);
}

/** Type guard: `value` is a valid Effort — one of the named levels. */
function isEffort(raw: unknown): raw is Effort {
  return typeof raw === 'string' && VALID_EFFORT_NAMES.includes(raw);
}

/**
 * Validate and freeze a single raw role-def object. Returns null if any required
 * field is missing or the wrong type.
 */
function parseRoleDef(raw: unknown): RoleDef | null {
  if (!isPlainObject(raw)) return null;

  const { displayName, phases, skills, agent, model, effort, contextWindow, producesArtifacts } =
    raw;

  if (typeof displayName !== 'string') return null;
  if (!isPhaseArray(phases)) return null;
  if (!isStringArray(skills)) return null;
  if (typeof agent !== 'string') return null;
  if (typeof model !== 'string') return null;
  if (!isEffort(effort)) return null;
  if (!isStringArray(producesArtifacts)) return null;

  // `contextWindow` is optional and additive: keep it only when it is a positive finite number,
  // otherwise drop it (drop-don't-throw) so an older or malformed roster still parses.
  const hasValidWindow =
    typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0;

  return Object.freeze<RoleDef>({
    displayName,
    phases: Object.freeze(phases.map((phase) => Object.freeze({ ...phase }))),
    skills: Object.freeze([...skills]),
    agent,
    model,
    effort,
    ...(hasValidWindow ? { contextWindow } : {}),
    producesArtifacts: Object.freeze([...producesArtifacts]),
  });
}

/**
 * Validate the raw `pipeline` array: must be a non-empty array of strings that are
 * ALL valid roles (per isValidRole). Returns null on any violation.
 */
function parsePipeline(raw: unknown): readonly Role[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const pipeline: Role[] = [];
  for (const entry of raw) {
    if (!isValidRole(entry)) return null;
    pipeline.push(entry);
  }
  return Object.freeze(pipeline);
}

/**
 * Validate the raw `roles` object against a known pipeline: every pipeline role
 * must have a well-formed def. Returns null if any pipeline role is missing from
 * `roles` or its def fails validation.
 */
function parseRoles(
  raw: unknown,
  pipeline: readonly Role[],
): Readonly<Record<Role, RoleDef>> | null {
  if (!isPlainObject(raw)) return null;

  const roles = {} as Record<Role, RoleDef>;
  for (const role of pipeline) {
    const rawDef: unknown = raw[role];
    if (rawDef === undefined) return null;
    const def = parseRoleDef(rawDef);
    if (def === null) return null;
    roles[role] = def;
  }
  return Object.freeze(roles);
}

/**
 * Parse and validate a raw parsed-JSON value into a frozen Roster. Returns null on
 * any structural or type violation.
 */
function parseRoster(raw: unknown): Roster | null {
  if (!isPlainObject(raw)) return null;

  const { schemaVersion, pipeline: rawPipeline, roles: rawRoles } = raw;
  if (schemaVersion !== EXPECTED_SCHEMA_VERSION) return null;

  const pipeline = parsePipeline(rawPipeline);
  if (pipeline === null) return null;

  const roles = parseRoles(rawRoles, pipeline);
  if (roles === null) return null;

  return Object.freeze<Roster>({
    schemaVersion,
    pipeline,
    roles,
  });
}

/**
 * Read the role roster for `projectPath`: `<projectPath>/.claude/harness-roles.json`.
 * Best-effort: reads, parses, and validates the file in a single try/catch. Any
 * problem — missing file, malformed JSON, wrong schemaVersion, an empty/invalid
 * pipeline, an unknown pipeline role, or a pipeline role missing its `roles.<name>`
 * def — yields `null`. NEVER throws.
 */
export function readRoster(projectPath: string): Roster | null {
  try {
    const raw = readFileSync(join(projectPath, ROSTER_REL_PATH), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parseRoster(parsed);
  } catch {
    return null;
  }
}
