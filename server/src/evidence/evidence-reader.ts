// Best-effort evidence reader for a single `tasks/stories/<id>/` work item.
//
// Mirrors the codebase's "drop, don't throw / frozen-return / hard-caps" boundary-
// reader template (see lifecycle/story-state-reader.ts, session/persona-reader.ts):
//
//  - Drop, don't throw: a missing story dir, an unreadable artifact, a non-repo
//    project path, or any other failure yields empty-but-frozen fields —
//    readEvidence NEVER throws and NEVER rejects.
//  - Immutable: every return is a fresh Object.freeze(...)'d EvidenceData.
//  - Hard cap: each file read is byte-capped at 256 KiB, same cap as the other
//    boundary readers in this codebase.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { parsePhaseMarker } from '../lifecycle/story-state-reader.js';
import { readChangedFiles } from '../git/git-state-reader.js';
import type { EvidenceArtifact, EvidenceData } from '../ws-protocol.js';

const STORIES_REL_PATH = join('tasks', 'stories');
const PHASE_MARKER_FILE = 'phase.md';
const REGRESSION_LOG_FILE = 'regression.log';
const EVALUATION_FILE = 'evaluation.md';
const ACCEPTANCE_FILE = 'acceptance.md';
const PR_BODY_FILE = 'pr-body.md';

// Same allowlist a workItemId is validated against elsewhere (ws-protocol.ts
// isSafeWorkItemId, persona-reader.ts) — defense-in-depth so this reader can
// never join an unsafe segment into a filesystem path.
const SAFE_WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Cap on how much of any single artifact file we read before giving up — a
// well-formed artifact is a few KiB; the cap defends against a pathological file.
const MAX_ARTIFACT_BYTES = 256 * 1024; // 256 KiB

// Fixed, deterministic allowlist of known artifact filenames, in display order.
const ARTIFACT_ALLOWLIST: readonly string[] = [
  'brief.md',
  'plan.md',
  'test-strategy.md',
  'evaluation.md',
  'acceptance.md',
  'security-review.md',
  'architecture-review.md',
  'pr-body.md',
  'decisions-log.md',
  'regression.log',
];

const EMPTY_EVIDENCE: EvidenceData = Object.freeze({
  filesChanged: Object.freeze([]),
  testResults: Object.freeze({ summary: '' }),
  prSummary: '',
  artifacts: Object.freeze([]),
});

/** Read a story artifact file, byte-capped and trimmed. Missing/unreadable → null. Never throws. */
async function readArtifactFile(storyDir: string, fileName: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(storyDir, fileName), 'utf8');
    return raw.slice(0, MAX_ARTIFACT_BYTES).trim();
  } catch {
    return null;
  }
}

/** Whether `fileName` exists inside `storyDir`. Never throws. */
async function fileExists(storyDir: string, fileName: string): Promise<boolean> {
  try {
    await fs.access(join(storyDir, fileName));
    return true;
  } catch {
    return false;
  }
}

/** Read and parse the `phase.md` marker of `storyDir`. Missing/malformed → null. Never throws. */
async function readPhase(storyDir: string): Promise<'planning' | 'coding' | 'testing' | 'reviewing' | 'shipping' | null> {
  try {
    const raw = await fs.readFile(join(storyDir, PHASE_MARKER_FILE), 'utf8');
    return parsePhaseMarker(raw.slice(0, MAX_ARTIFACT_BYTES));
  } catch {
    return null;
  }
}

/**
 * Read the test-results summary for `storyDir`: `regression.log` if present,
 * else `evaluation.md`, else `acceptance.md`, else empty string. Never throws.
 */
async function readTestResultsSummary(storyDir: string): Promise<string> {
  const regressionLog = await readArtifactFile(storyDir, REGRESSION_LOG_FILE);
  if (regressionLog !== null) return regressionLog;

  const evaluation = await readArtifactFile(storyDir, EVALUATION_FILE);
  if (evaluation !== null) return evaluation;

  const acceptance = await readArtifactFile(storyDir, ACCEPTANCE_FILE);
  if (acceptance !== null) return acceptance;

  return '';
}

/**
 * Read the evidence bundle for `workItemId` in `projectPath`: changed files (via
 * the git reader), Draft/Final-badged known artifacts, a test-results summary,
 * and the PR body summary. Best-effort: a missing story dir, an unsafe
 * workItemId, or any per-file failure yields empty fields, never throws.
 */
export async function readEvidence(projectPath: string, workItemId: string): Promise<EvidenceData> {
  if (!SAFE_WORK_ITEM_ID_PATTERN.test(workItemId)) {
    return EMPTY_EVIDENCE;
  }

  const filesChanged = await readChangedFiles(projectPath);

  const storyDir = join(projectPath, STORIES_REL_PATH, workItemId);
  const phase = await readPhase(storyDir);
  const state: EvidenceArtifact['state'] = phase === 'shipping' ? 'Final' : 'Draft';

  const artifacts: EvidenceArtifact[] = [];
  for (const name of ARTIFACT_ALLOWLIST) {
    if (await fileExists(storyDir, name)) {
      artifacts.push(Object.freeze({ name, state }));
    }
  }

  const testResultsSummary = await readTestResultsSummary(storyDir);
  const prSummary = (await readArtifactFile(storyDir, PR_BODY_FILE)) ?? '';

  return Object.freeze<EvidenceData>({
    filesChanged,
    testResults: Object.freeze({ summary: testResultsSummary }),
    prSummary,
    artifacts: Object.freeze(artifacts),
  });
}
