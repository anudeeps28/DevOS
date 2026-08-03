// The Bridge — per-project pipeline state machine (SPEC §3.2, M2 orchestration).
//
// Drives one project's role pipeline (from its `.claude/harness-roles.json` roster)
// through the SessionManager: spawn the next role, watch its owned session end/error,
// and decide whether to auto-advance, pause for approval, rework, or escalate. Pipeline
// POSITION is a thin, in-memory anchor ONLY — it is NEVER persisted (a server restart
// loses in-flight Bridge position; the durable `sessions` rows are the historical
// record, written by the SessionManager via `currentStage`).
//
// Subscribes ONCE to `sessionManager.onState` and correlates each snapshot to the
// owning run by `snapshot.id === run.currentSessionId` — a project can have sibling,
// non-Bridge-owned sessions, so matching by project path alone would misattribute.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Registry } from '../registry/registry.js';
import type { BridgeGate, BridgeInboxItem, BridgeStateSnapshot } from '../ws-protocol.js';
import { createPhaseWatcher, type PhaseTransitionSignal, type PhaseWatcher } from './phase-watcher.js';
import { defaultOpenPr, type OpenPrAdapter } from './pr-adapter.js';
import { buildResumePrompt } from './resume-prompt.js';
import type { Role } from './roles.js';
import { readRoster, type Roster } from './roster-reader.js';
import type {
  ContextConfigWarning,
  ContextUsageSignal,
  SessionManager,
  SessionSnapshot,
} from './session-manager.js';
import type { EngineQuestionRequest } from './session-engine.js';

/** Public surface of the Bridge — one instance drives every pinned project's run. */
export interface Bridge {
  readonly start: (projectPath: string, workItemId?: string) => void;
  readonly approveGate: (projectPath: string) => void;
  readonly interrupt: (
    projectPath: string,
    kind: 'interrupt' | 'question' | 'escalation',
    reason: string,
  ) => void;
  /** Steer the builder while its plan is paused for review, then re-arm the plan gate
   * for the revised plan's next planning→coding transition. No-op unless the run is
   * genuinely `planGatePending` with a live current session. */
  readonly requestChanges: (projectPath: string, notes: string) => void;
  /** Answer a parked agent question (chip or free text) for a pinned project's run.
   * No-op unless the run has a pending question. */
  readonly answerQuestion: (projectPath: string, answer: string) => void;
  /** Resolve the current escalation for a pinned project's run with one of three
   * explicit operator choices. No-op unless the run is genuinely `escalated`. */
  readonly resolveEscalation: (
    projectPath: string,
    choice: 'let-debug-try' | 'give-guidance' | 'take-over',
    notes?: string,
  ) => void;
  readonly onState: (listener: (snap: BridgeStateSnapshot) => void) => () => void;
  readonly getState: (projectPath: string) => BridgeStateSnapshot | null;
  readonly getInbox: (projectPath: string) => readonly BridgeInboxItem[];
  /** Tear down every live plan-gate `phase.md` watcher. Called on server shutdown so
   * fs.watch handles for in-flight plan-gated builders do not outlive the process's stop. */
  readonly stopAll: () => void;
}

export interface BridgeDeps {
  readonly sessionManager: SessionManager;
  readonly registry: Registry;
  /** Per-project roster resolution — defaults to `readRoster`. Tests inject a fake. */
  readonly resolveRoster?: (projectPath: string) => Roster | null;
  /** Read a stage's failure report (rework input) — defaults to a simple file read. */
  readonly readFailureReport?: (projectPath: string, stage: string) => string | null;
  /** Max consecutive reworks before escalating instead of looping. Defaults to 3. */
  readonly reworkLoopCap?: number;
  /** Read the reviewer's verdict artifact — defaults to a best-effort file read; null when absent. */
  readonly readReviewVerdict?: (
    projectPath: string,
    workItemId?: string,
  ) => 'BLOCK' | 'CLEAR' | null;
  /** Read the reviewer's findings report (BLOCK rework work order) — defaults to a file read. */
  readonly readReviewReport?: (projectPath: string, workItemId?: string) => string | null;
  /** Draft the PR body from the CLEAR verdict — defaults to a file read. */
  readonly draftPrBody?: (
    projectPath: string,
    workItemId?: string,
  ) => { title: string; body: string; verdicts: readonly string[]; advisories: readonly string[] } | null;
  /** Mechanical open-PR seam invoked on a CLEAR verdict — defaults to `defaultOpenPr`. */
  readonly openPr?: OpenPrAdapter;
  /** Max context-recycle respawns per run before escalating instead of resuming again. Defaults to 2. */
  readonly contextRespawnCap?: number;
  /** Watches a run's `phase.md` marker for the plan-gate's planning→coding transition —
   * defaults to `createPhaseWatcher()`. Tests inject a fake. */
  readonly phaseWatcher?: PhaseWatcher;
}

const DEFAULT_REWORK_LOOP_CAP = 3;
const DEFAULT_CONTEXT_RESPAWN_CAP = 2;
// Fixed diagnosis instruction for the "let debug try" escalation choice — the
// /debug spirit (rules/autonomous-mode.md): reproduce the failure deterministically,
// test one hypothesis at a time, fix the root cause before resuming.
export const DEBUG_TAKEOVER_PROMPT =
  'The pipeline escalated after repeated failures. Reproduce the failure deterministically, ' +
  'then diagnose it one hypothesis at a time — test each hypothesis and revert if it does not ' +
  'hold before moving to the next. Fix the root cause, not a symptom, before resuming normal work.';
const FAILURE_REPORT_REL_DIR = join('.claude', 'failure-reports');
// The two-session handoff contract (SPEC §3.1, .claude/agents/{builder,reviewer}.md):
// every artifact the sessions exchange lives in `tasks/stories/<id>/`, NOT in a
// `.claude/review/` sidecar. The reviewer writes its findings + verdict into
// `evaluation.md` (verdict token: APPROVE / CHANGES REQUIRED); the builder drafts the
// PR body into `pr-body.md`. The Bridge reads from exactly those paths.
const STORIES_REL_DIR = join('tasks', 'stories');
const EVALUATION_FILE = 'evaluation.md';
const PR_BODY_FILE = 'pr-body.md';

// Cap on how much of a story artifact we read before giving up — mirrors the
// story-state-reader byte cap; defends against a pathological repo-local file.
const MAX_REVIEW_BYTES = 256 * 1024; // 256 KiB

/** Best-effort bounded read of a `tasks/stories/<id>/<file>`. Returns null (never
 * throws) on a missing workItemId, missing file, or any read error; caps the parsed
 * content at MAX_REVIEW_BYTES. */
function readStoryArtifact(
  projectPath: string,
  workItemId: string | undefined,
  file: string,
): string | null {
  if (workItemId === undefined) return null;
  try {
    const raw = readFileSync(join(projectPath, STORIES_REL_DIR, workItemId, file), 'utf8');
    return raw.slice(0, MAX_REVIEW_BYTES);
  } catch {
    return null;
  }
}

/** Default `readFailureReport`: read `<projectPath>/.claude/failure-reports/<stage>.md`. */
function defaultReadFailureReport(projectPath: string, stage: string): string | null {
  try {
    return readFileSync(join(projectPath, FAILURE_REPORT_REL_DIR, `${stage}.md`), 'utf8');
  } catch {
    return null;
  }
}

/** Default `readReviewVerdict`: parse the reviewer's verdict from
 * `tasks/stories/<id>/evaluation.md`. The reviewer states its verdict as APPROVE
 * (→ CLEAR) or CHANGES REQUIRED (→ BLOCK); CHANGES REQUIRED is matched first so the
 * word "approve" appearing elsewhere in the prose can't mask a blocking verdict.
 * Absent file / no recognizable verdict → null (defer to a human). Never throws. */
export function defaultReadReviewVerdict(
  projectPath: string,
  workItemId?: string,
): 'BLOCK' | 'CLEAR' | null {
  const content = readStoryArtifact(projectPath, workItemId, EVALUATION_FILE);
  if (content === null) return null;
  if (/changes\s+required/i.test(content)) return 'BLOCK';
  if (/\bapprove(d|s)?\b/i.test(content)) return 'CLEAR';
  return null;
}

/** Default `readReviewReport`: the reviewer's findings in
 * `tasks/stories/<id>/evaluation.md` — the BLOCK rework work order. Never throws. */
export function defaultReadReviewReport(projectPath: string, workItemId?: string): string | null {
  return readStoryArtifact(projectPath, workItemId, EVALUATION_FILE);
}

/** Default `draftPrBody`: read the builder-drafted PR body from
 * `tasks/stories/<id>/pr-body.md` (first non-empty line, leading `#`s stripped, is
 * the title; the whole file is the body). Only runs on a CLEAR verdict, so `verdicts`
 * carries `CLEAR`; richer verdict/advisory extraction is left to an injected dep.
 * Absent/titleless file → null (Bridge escalates rather than opening a blank PR).
 * Never throws. */
export function defaultDraftPrBody(
  projectPath: string,
  workItemId?: string,
): { title: string; body: string; verdicts: readonly string[]; advisories: readonly string[] } | null {
  const content = readStoryArtifact(projectPath, workItemId, PR_BODY_FILE);
  if (content === null) return null;
  const titleLine = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const title = titleLine.replace(/^#+\s*/, '').trim();
  if (title.length === 0) return null;
  return { title, body: content, verdicts: ['CLEAR'], advisories: [] };
}

/** One project's in-memory Bridge run state — the thin anchor. Never persisted. */
interface BridgeRun {
  readonly projectPath: string;
  readonly pipeline: readonly Role[];
  /** The roster's per-role defs — the source of each spawn's declared model + effort. */
  readonly roles: Roster['roles'];
  readonly workItemId?: string;
  index: number;
  currentSessionId: string | null;
  gate: BridgeGate;
  inbox: BridgeInboxItem[];
  reworkCount: number;
  /** Set by `interrupt`; blocks auto-advance on the next `ended` until approved. */
  paused: boolean;
  /** Count of context-recycle respawns for this run. In-memory only, never persisted. */
  contextRespawnCount: number;
  /** Set when the builder is spawned with the plan gate on — watching for its
   * planning→coding phase transition. Cleared once that transition fires. */
  planGateArmed: boolean;
  /** Set when the plan gate has paused the builder for review; cleared by
   * `approveGate` (steer + resume) or `requestChanges` (steer + re-arm). */
  planGatePending: boolean;
  /** Set when an agent-raised question is parked awaiting an operator answer;
   * cleared by `answerQuestion` or session teardown (handleEnded/handleErrored). */
  pendingQuestion: { sessionId: string; requestId: string } | null;
}

/** Safe indexed access into a pipeline (noUncheckedIndexedAccess-friendly). */
function stageAt(pipeline: readonly Role[], index: number): Role | null {
  const role = pipeline[index];
  return role === undefined ? null : role;
}

export function createBridge(deps: BridgeDeps): Bridge {
  const { sessionManager, registry } = deps;
  const resolveRoster = deps.resolveRoster ?? readRoster;
  const readFailureReport = deps.readFailureReport ?? defaultReadFailureReport;
  const reworkLoopCap = deps.reworkLoopCap ?? DEFAULT_REWORK_LOOP_CAP;
  const readReviewVerdict = deps.readReviewVerdict ?? defaultReadReviewVerdict;
  const readReviewReport = deps.readReviewReport ?? defaultReadReviewReport;
  const draftPrBody = deps.draftPrBody ?? defaultDraftPrBody;
  const openPr = deps.openPr ?? defaultOpenPr;
  const contextRespawnCap = deps.contextRespawnCap ?? DEFAULT_CONTEXT_RESPAWN_CAP;
  const phaseWatcher = deps.phaseWatcher ?? createPhaseWatcher();

  const runs = new Map<string, BridgeRun>();
  const listeners = new Set<(snap: BridgeStateSnapshot) => void>();

  const snapshot = (run: BridgeRun): BridgeStateSnapshot =>
    Object.freeze<BridgeStateSnapshot>({
      type: 'bridge-state',
      path: run.projectPath,
      stage: stageAt(run.pipeline, run.index) ?? '',
      gate: run.gate,
      sessionId: run.currentSessionId,
      inbox: Object.freeze([...run.inbox]),
      reworkCount: run.reworkCount,
    });

  const emit = (run: BridgeRun): void => {
    const snap = snapshot(run);
    for (const listener of listeners) {
      try {
        listener(snap);
      } catch (err) {
        console.error('[bridge] state listener threw', err);
      }
    }
  };

  const findRunBySessionId = (sessionId: string): BridgeRun | null => {
    for (const run of runs.values()) {
      if (run.currentSessionId === sessionId) return run;
    }
    return null;
  };

  const readPlanGate = (projectPath: string): boolean => {
    const project = registry.listProjects().find((p) => p.path === projectPath);
    const uiPrefs = project?.uiPrefs;
    if (typeof uiPrefs !== 'object' || uiPrefs === null) return false;
    return (uiPrefs as { plan_gate?: boolean }).plan_gate === true;
  };

  // Spawn `role` as the run's current session and emit the resulting state. Errors
  // are logged, not thrown — a spawn failure must not crash the Bridge or a sibling.
  const spawnAndEmit = async (
    run: BridgeRun,
    role: Role,
    stage: string,
    opts?: { readonly prompt?: string },
  ): Promise<void> => {
    try {
      // Source the declared model + effort and the work-item id from the run itself —
      // the single choke point where every spawn (first build, reviewer advance, and
      // every rework respawn) picks up the roster-declared model/effort and stamps
      // the durable session row with its work item.
      const roleDef = run.roles[role];
      const oldSessionId = run.currentSessionId;
      const snap: SessionSnapshot = await sessionManager.spawn({
        projectPath: run.projectPath,
        role,
        currentStage: stage,
        ...(run.workItemId !== undefined ? { workItemId: run.workItemId } : {}),
        ...(roleDef !== undefined ? { model: roleDef.model, effort: roleDef.effort } : {}),
        ...(roleDef?.contextWindow !== undefined ? { contextWindow: roleDef.contextWindow } : {}),
        ...(opts?.prompt !== undefined ? { prompt: opts.prompt } : {}),
      });
      run.currentSessionId = snap.id;
      // A watcher must never outlive the session it was watching — always clear the
      // replaced session's watch, whether or not the new spawn re-arms one.
      if (oldSessionId !== null) phaseWatcher.unwatch(oldSessionId);
      // Plan gate: only the pipeline's first role (the builder, index 0) is watched
      // for its planning→coding transition, and only when the project has the plan
      // gate on and this run carries a workItemId (the marker lives under its story dir).
      if (run.index === 0 && readPlanGate(run.projectPath) && run.workItemId !== undefined) {
        run.planGateArmed = true;
        phaseWatcher.watch({ sessionId: snap.id, projectPath: run.projectPath, workItemId: run.workItemId });
      } else {
        run.planGateArmed = false;
      }
      emit(run);
    } catch (err) {
      console.error(`[bridge] failed to spawn role "${role}" for ${run.projectPath}`, err);
    }
  };

  // Advance the run to the next pipeline role and spawn it. If already at the last
  // role, mark the run done instead.
  const advance = async (run: BridgeRun): Promise<void> => {
    const nextIndex = run.index + 1;
    const nextRole = stageAt(run.pipeline, nextIndex);
    if (nextRole === null) {
      run.gate = 'done';
      if (run.currentSessionId !== null) phaseWatcher.unwatch(run.currentSessionId);
      emit(run);
      return;
    }
    run.index = nextIndex;
    run.paused = false;
    run.gate = 'running';
    await spawnAndEmit(run, nextRole, nextRole);
  };

  // The reviewer (the pipeline's last role) ended: branch on its BLOCK/CLEAR
  // verdict rather than simply marking the run done.
  const handleReviewVerdict = async (run: BridgeRun): Promise<void> => {
    const verdict = readReviewVerdict(run.projectPath, run.workItemId);
    if (verdict === 'BLOCK') {
      const report = readReviewReport(run.projectPath, run.workItemId);
      const buildRole = stageAt(run.pipeline, 0);
      if (report !== null && run.reworkCount < reworkLoopCap && buildRole !== null) {
        run.reworkCount += 1;
        run.gate = 'reworking';
        run.index = 0;
        await spawnAndEmit(run, buildRole, buildRole, { prompt: report });
        return;
      }
      run.gate = 'escalated';
      run.inbox.push(
        Object.freeze<BridgeInboxItem>({
          stage: stageAt(run.pipeline, run.index) ?? '',
          kind: 'escalation',
          reason: report ?? 'Reviewer verdict BLOCK could not be recovered.',
          ts: Date.now(),
        }),
      );
      emit(run);
      return;
    }
    if (verdict === 'CLEAR') {
      const draft = draftPrBody(run.projectPath, run.workItemId);
      if (draft === null) {
        run.gate = 'escalated';
        run.inbox.push(
          Object.freeze<BridgeInboxItem>({
            stage: stageAt(run.pipeline, run.index) ?? '',
            kind: 'escalation',
            reason: 'Reviewer verdict CLEAR but no PR body could be drafted.',
            ts: Date.now(),
          }),
        );
        emit(run);
        return;
      }
      let result: Awaited<ReturnType<OpenPrAdapter>>;
      try {
        result = await openPr({
          projectPath: run.projectPath,
          title: draft.title,
          body: draft.body,
          verdicts: draft.verdicts,
          advisories: draft.advisories,
          ...(run.workItemId !== undefined ? { workItemId: run.workItemId } : {}),
        });
      } catch (err) {
        console.error(`[bridge] openPr adapter threw for ${run.projectPath}`, err);
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        run.gate = 'done';
        emit(run);
      } else {
        run.gate = 'escalated';
        run.inbox.push(
          Object.freeze<BridgeInboxItem>({
            stage: stageAt(run.pipeline, run.index) ?? '',
            kind: 'escalation',
            reason: result.error,
            ts: Date.now(),
          }),
        );
        emit(run);
      }
      return;
    }
    // Null verdict: defer to a human.
    run.gate = 'awaiting-approval';
    emit(run);
  };

  const handleEnded = async (run: BridgeRun): Promise<void> => {
    // A stale answer must not relay after the session terminated.
    run.pendingQuestion = null;
    const isLast = run.index >= run.pipeline.length - 1;
    // A context-budget escalation ("task too big — split it") is terminal for this
    // run: the over-budget session was asked to end at a boundary, and its later
    // natural `ended` must NOT advance the pipeline or open a PR. Mirrors the
    // run.paused guard below; checked first because escalated outranks any pause.
    if (run.gate === 'escalated') return;
    // An interrupt during this stage pins the run at awaiting-approval — the next
    // `ended` must not sneak past it into the now-unconditional advance (AC3).
    if (run.paused) {
      run.gate = 'awaiting-approval';
      emit(run);
      return;
    }
    // A builder that ended/errored while its plan awaits review must not advance
    // to the next stage — the plan gate, not the pipeline, owns this pause.
    if (run.planGatePending) {
      run.gate = 'awaiting-approval';
      emit(run);
      return;
    }
    if (isLast) {
      await handleReviewVerdict(run);
      return;
    }
    await advance(run);
  };

  const handleErrored = async (run: BridgeRun): Promise<void> => {
    // A stale answer must not relay after the session terminated.
    run.pendingQuestion = null;
    const stage = stageAt(run.pipeline, run.index) ?? '';
    // Same terminal guard as handleEnded: once escalated for context budget, an
    // `errored` end must not sneak into rework/escalate again.
    if (run.gate === 'escalated') return;
    // A human interrupt pins the run at awaiting-approval regardless of how the
    // stage's session then terminates — an `errored` end must not sneak past the
    // pause into rework/escalate any more than an `ended` one can (AC3). Mirrors
    // the `run.paused` guard in `handleEnded`.
    if (run.paused) {
      run.gate = 'awaiting-approval';
      emit(run);
      return;
    }
    // Same plan-gate guard as handleEnded: an errored end must not sneak past a
    // pending plan review into rework/escalate any more than a paused one can.
    if (run.planGatePending) {
      run.gate = 'awaiting-approval';
      emit(run);
      return;
    }
    const report = readFailureReport(run.projectPath, stage);
    const buildRole = stageAt(run.pipeline, 0);
    if (report !== null && run.reworkCount < reworkLoopCap && buildRole !== null) {
      run.reworkCount += 1;
      run.gate = 'reworking';
      run.index = 0;
      await spawnAndEmit(run, buildRole, buildRole, { prompt: report });
      return;
    }
    run.gate = 'escalated';
    if (run.currentSessionId !== null) phaseWatcher.unwatch(run.currentSessionId);
    run.inbox.push(
      Object.freeze<BridgeInboxItem>({
        stage,
        kind: 'escalation',
        reason: report ?? `Stage "${stage}" errored and could not be recovered.`,
        ts: Date.now(),
      }),
    );
    emit(run);
  };

  sessionManager.onState((snap: SessionSnapshot) => {
    const run = findRunBySessionId(snap.id);
    if (run === null) return;
    if (snap.status === 'ended') {
      void handleEnded(run);
    } else if (snap.status === 'errored') {
      void handleErrored(run);
    }
  });

  // The plan gate's watched builder crossed out of `planning` — the plan is ready
  // for human review. Pause the turn (the session stays alive; `approveGate` /
  // `requestChanges` steer it) rather than letting it run straight through to
  // implementation.
  const handlePlanGateTransition = async (signal: PhaseTransitionSignal): Promise<void> => {
    const run = findRunBySessionId(signal.sessionId);
    if (run === null) return;
    if (run.gate !== 'running' || !run.planGateArmed || signal.phase === 'planning') return;
    try {
      await sessionManager.interrupt(signal.sessionId);
    } catch (err) {
      console.error(`[bridge] plan-gate interrupt failed for ${signal.sessionId}`, err);
    }
    run.planGateArmed = false;
    run.planGatePending = true;
    run.gate = 'awaiting-approval';
    run.inbox.push(
      Object.freeze<BridgeInboxItem>({
        stage: stageAt(run.pipeline, run.index) ?? '',
        kind: 'question',
        reason: 'Plan ready for review — approve or request changes.',
        ts: Date.now(),
      }),
    );
    phaseWatcher.unwatch(signal.sessionId);
    emit(run);
  };

  phaseWatcher.onPhaseTransition((signal: PhaseTransitionSignal) => void handlePlanGateTransition(signal));

  // A session's context-window occupancy crossed the threshold: respawn the SAME
  // stage with a resume prompt (context-recycle), or escalate once the per-run cap
  // is hit. This is a same-stage respawn, never a pipeline advance — the old
  // session's `currentSessionId` is overwritten BEFORE it is asked to end, so its
  // later `ended` no longer correlates to this run and `handleEnded` ignores it.
  const handleContextUsage = async (signal: ContextUsageSignal): Promise<void> => {
    const run = findRunBySessionId(signal.sessionId);
    if (run === null) return;
    if (run.gate === 'escalated' || run.gate === 'done') return;

    if (run.contextRespawnCount >= contextRespawnCap) {
      // Cap hit: stop respawning and escalate. Set the terminal gate BEFORE ending
      // the session so its subsequent `ended` hits the escalated guard in
      // handleEnded and cannot advance the pipeline. End the over-budget session at
      // a clean boundary rather than leaving it running past 80% indefinitely.
      run.gate = 'escalated';
      // Tear down the plan-gate watcher for the over-budget builder before ending it —
      // the escalate is terminal for this session, so its watcher must not outlive the
      // stage (mirrors handleErrored's escalate path).
      if (run.currentSessionId !== null) phaseWatcher.unwatch(run.currentSessionId);
      run.inbox.push(
        Object.freeze<BridgeInboxItem>({
          stage: stageAt(run.pipeline, run.index) ?? '',
          kind: 'escalation',
          reason: 'task too big — split it',
          ts: Date.now(),
        }),
      );
      const overBudgetId = run.currentSessionId;
      emit(run);
      if (overBudgetId !== null) sessionManager.endAtBoundary(overBudgetId);
      return;
    }

    const role = stageAt(run.pipeline, run.index);
    if (role === null) return;

    run.contextRespawnCount += 1;
    const prompt = buildResumePrompt(
      { workItemId: run.workItemId ?? '' },
      (file) => readStoryArtifact(run.projectPath, run.workItemId, file),
    );
    const oldId = run.currentSessionId;
    await spawnAndEmit(run, role, role, { prompt });
    // The safety of ending the old session below rests on spawnAndEmit having overwritten
    // `currentSessionId` with the NEW session — so the old session's later `ended` no longer
    // correlates to this run (see the block comment above). But spawnAndEmit SWALLOWS a spawn
    // failure (logs, never throws), leaving `currentSessionId` still pointing at the old
    // session. If we then ended it, its `ended` would correlate, hit handleEnded with a
    // non-escalated gate, and advance the pipeline onto half-finished work — the exact hazard
    // the cap-hit path guards against with an escalated gate. Detect the failed respawn (no
    // overwrite) and escalate the same way instead of silently advancing.
    if (run.currentSessionId === oldId) {
      run.gate = 'escalated';
      // Failed respawn escalates terminally — unwatch the stranded old session's
      // plan-gate watcher so it does not leak past this stage (mirrors handleErrored).
      if (oldId !== null) phaseWatcher.unwatch(oldId);
      run.inbox.push(
        Object.freeze<BridgeInboxItem>({
          stage: stageAt(run.pipeline, run.index) ?? '',
          kind: 'escalation',
          reason: 'context-recycle respawn failed to start — no successor session; needs a human.',
          ts: Date.now(),
        }),
      );
      emit(run);
    }
    if (oldId !== null) sessionManager.endAtBoundary(oldId);
  };

  sessionManager.onContextUsage((signal: ContextUsageSignal) => void handleContextUsage(signal));

  // A session fell back to the guessed default context window (no roster-declared window and an
  // unrecognized model). This is a config problem — the recycle brake may fire far too early —
  // that only reaches the server's stdout otherwise. Surface it in the Needs-you inbox so a human
  // sees it. Advisory only: it does NOT change the run's gate (an otherwise-healthy run keeps
  // going), and the SessionManager's once-per-session latch means it can be pushed at most once.
  const handleContextConfigWarning = (warning: ContextConfigWarning): void => {
    const run = findRunBySessionId(warning.sessionId);
    if (run === null) return;
    run.inbox.push(
      Object.freeze<BridgeInboxItem>({
        stage: stageAt(run.pipeline, run.index) ?? '',
        kind: 'escalation',
        reason:
          `No declared or known context window for model "${warning.model}" — recycling against ` +
          `the ${warning.fallbackWindow}-token default (may trigger far too early). Declare ` +
          `contextWindow in harness-roles.json or add a [1m]-style marker to the model id.`,
        ts: Date.now(),
      }),
    );
    emit(run);
  };

  sessionManager.onContextConfigWarning((warning: ContextConfigWarning) =>
    handleContextConfigWarning(warning),
  );

  // A live session raised a decision question via `ask_operator` — park a `question`
  // inbox item (ALWAYS carrying `chips`, even empty, so the UI discriminator holds
  // against the plan-gate question which never sets `chips`) and pause the run for
  // the operator's answer.
  const handleQuestionRequest = (sessionId: string, req: EngineQuestionRequest): void => {
    const run = findRunBySessionId(sessionId);
    if (run === null) return;
    run.inbox.push(
      Object.freeze<BridgeInboxItem>({
        stage: stageAt(run.pipeline, run.index) ?? '',
        kind: 'question',
        reason: req.question,
        chips: req.chips,
        ts: Date.now(),
      }),
    );
    run.pendingQuestion = { sessionId, requestId: req.requestId };
    run.paused = true;
    run.gate = 'awaiting-approval';
    emit(run);
  };

  sessionManager.onQuestionRequest((_projectPath, sessionId, req) =>
    handleQuestionRequest(sessionId, req),
  );

  const start = (projectPath: string, workItemId?: string): void => {
    const roster = resolveRoster(projectPath);
    if (roster === null) return;
    const firstRole = stageAt(roster.pipeline, 0);
    if (firstRole === null) return;

    const run: BridgeRun = {
      projectPath,
      pipeline: roster.pipeline,
      roles: roster.roles,
      ...(workItemId !== undefined ? { workItemId } : {}),
      index: 0,
      currentSessionId: null,
      gate: 'running',
      inbox: [],
      reworkCount: 0,
      paused: false,
      contextRespawnCount: 0,
      planGateArmed: false,
      planGatePending: false,
      pendingQuestion: null,
    };
    runs.set(projectPath, run);

    void spawnAndEmit(run, firstRole, firstRole);
  };

  const approveGate = (projectPath: string): void => {
    const run = runs.get(projectPath);
    if (run === undefined) return;
    if (run.gate !== 'awaiting-approval') return;
    if (run.planGatePending) {
      run.planGatePending = false;
      run.paused = false;
      run.gate = 'running';
      if (run.currentSessionId !== null) {
        sessionManager.sendInput(run.currentSessionId, 'Plan approved — continue with implementation.');
      }
      emit(run);
      return;
    }
    run.paused = false;
    void advance(run);
  };

  const requestChanges = (projectPath: string, notes: string): void => {
    const run = runs.get(projectPath);
    if (run === undefined) return;
    if (!run.planGatePending || run.currentSessionId === null) return;
    sessionManager.sendInput(run.currentSessionId, notes);
    // Re-arm the plan gate: the revised plan will re-pause on its next
    // planning→coding transition, same as the first spawn's arm in spawnAndEmit.
    run.planGateArmed = true;
    run.planGatePending = false;
    run.paused = false;
    run.gate = 'running';
    if (run.workItemId !== undefined) {
      phaseWatcher.watch({
        sessionId: run.currentSessionId,
        projectPath: run.projectPath,
        workItemId: run.workItemId,
      });
    }
    emit(run);
  };

  const answerQuestion = (projectPath: string, answer: string): void => {
    const run = runs.get(projectPath);
    if (run === undefined) return;
    if (run.pendingQuestion === null) return;
    sessionManager.answerQuestion(run.pendingQuestion.sessionId, run.pendingQuestion.requestId, answer);
    // Remove the agent-question inbox item(s) — the ones carrying `chips` (the
    // plan-gate question never sets it, so this can't accidentally clear that card).
    run.inbox = run.inbox.filter((item) => item.chips === undefined);
    run.pendingQuestion = null;
    run.paused = false;
    run.gate = 'running';
    emit(run);
  };

  const resolveEscalation = (
    projectPath: string,
    choice: 'let-debug-try' | 'give-guidance' | 'take-over',
    notes?: string,
  ): void => {
    const run = runs.get(projectPath);
    if (run === undefined) return;
    if (run.gate !== 'escalated') return;
    if (choice === 'take-over') {
      run.inbox = [];
      emit(run);
      return;
    }
    const buildRole = stageAt(run.pipeline, 0);
    if (buildRole === null) return;
    run.reworkCount = 0;
    run.index = 0;
    run.gate = 'reworking';
    run.inbox = [];
    const prompt = choice === 'let-debug-try' ? DEBUG_TAKEOVER_PROMPT : (notes ?? '');
    void spawnAndEmit(run, buildRole, buildRole, { prompt });
  };

  const interrupt = (
    projectPath: string,
    kind: 'interrupt' | 'question' | 'escalation',
    reason: string,
  ): void => {
    const run = runs.get(projectPath);
    if (run === undefined) return;
    const stage = stageAt(run.pipeline, run.index) ?? '';
    run.inbox.push(Object.freeze<BridgeInboxItem>({ stage, kind, reason, ts: Date.now() }));
    run.paused = true;
    run.gate = 'awaiting-approval';
    emit(run);
  };

  const onState = (listener: (snap: BridgeStateSnapshot) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const getState = (projectPath: string): BridgeStateSnapshot | null => {
    const run = runs.get(projectPath);
    return run === undefined ? null : snapshot(run);
  };

  const getInbox = (projectPath: string): readonly BridgeInboxItem[] => {
    const run = runs.get(projectPath);
    return run === undefined ? Object.freeze([]) : Object.freeze([...run.inbox]);
  };

  const stopAll = (): void => {
    phaseWatcher.stopAll();
  };

  return Object.freeze<Bridge>({
    start,
    approveGate,
    interrupt,
    requestChanges,
    answerQuestion,
    resolveEscalation,
    onState,
    getState,
    getInbox,
    stopAll,
  });
}
