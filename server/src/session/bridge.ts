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
import type { Role } from './roles.js';
import { readRoster, type Roster } from './roster-reader.js';
import type { SessionManager, SessionSnapshot } from './session-manager.js';

/** Public surface of the Bridge — one instance drives every pinned project's run. */
export interface Bridge {
  readonly start: (projectPath: string, workItemId?: string) => void;
  readonly approveGate: (projectPath: string) => void;
  readonly interrupt: (
    projectPath: string,
    kind: 'interrupt' | 'question' | 'escalation',
    reason: string,
  ) => void;
  readonly onState: (listener: (snap: BridgeStateSnapshot) => void) => () => void;
  readonly getState: (projectPath: string) => BridgeStateSnapshot | null;
  readonly getInbox: (projectPath: string) => readonly BridgeInboxItem[];
}

export interface BridgeDeps {
  readonly sessionManager: SessionManager;
  readonly registry: Registry;
  /** Per-project roster resolution — defaults to `readRoster`. Tests inject a fake. */
  readonly resolveRoster?: (projectPath: string) => Roster | null;
  /** Read a stage's failure report (rework input) — defaults to a simple file read. */
  readonly readFailureReport?: (projectPath: string, stage: string) => string | null;
  /** Max consecutive reworks before escalating instead of looping. Defaults to 2. */
  readonly reworkLoopCap?: number;
}

const DEFAULT_REWORK_LOOP_CAP = 2;
const FAILURE_REPORT_REL_DIR = join('.claude', 'failure-reports');

/** Default `readFailureReport`: read `<projectPath>/.claude/failure-reports/<stage>.md`. */
function defaultReadFailureReport(projectPath: string, stage: string): string | null {
  try {
    return readFileSync(join(projectPath, FAILURE_REPORT_REL_DIR, `${stage}.md`), 'utf8');
  } catch {
    return null;
  }
}

/** One project's in-memory Bridge run state — the thin anchor. Never persisted. */
interface BridgeRun {
  readonly projectPath: string;
  readonly pipeline: readonly Role[];
  index: number;
  currentSessionId: string | null;
  gate: BridgeGate;
  inbox: BridgeInboxItem[];
  reworkCount: number;
  /** Set by `interrupt`; blocks auto-advance on the next `ended` until approved. */
  paused: boolean;
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

  const readAutoAdvance = (projectPath: string): boolean => {
    const project = registry.listProjects().find((p) => p.path === projectPath);
    const uiPrefs = project?.uiPrefs;
    if (typeof uiPrefs !== 'object' || uiPrefs === null) return false;
    return (uiPrefs as { auto_advance?: boolean }).auto_advance === true;
  };

  // Spawn `role` as the run's current session and emit the resulting state. Errors
  // are logged, not thrown — a spawn failure must not crash the Bridge or a sibling.
  const spawnAndEmit = async (
    run: BridgeRun,
    role: Role,
    stage: string,
    opts?: { readonly workItemId?: string; readonly prompt?: string },
  ): Promise<void> => {
    try {
      const snap: SessionSnapshot = await sessionManager.spawn({
        projectPath: run.projectPath,
        role,
        currentStage: stage,
        ...(opts?.workItemId !== undefined ? { workItemId: opts.workItemId } : {}),
        ...(opts?.prompt !== undefined ? { prompt: opts.prompt } : {}),
      });
      run.currentSessionId = snap.id;
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
      emit(run);
      return;
    }
    run.index = nextIndex;
    run.paused = false;
    run.gate = 'running';
    await spawnAndEmit(run, nextRole, nextRole);
  };

  const handleEnded = async (run: BridgeRun): Promise<void> => {
    const isLast = run.index >= run.pipeline.length - 1;
    if (isLast) {
      run.gate = 'done';
      emit(run);
      return;
    }
    // An interrupt during this stage pins the run at awaiting-approval regardless
    // of auto_advance — the next `ended` must not sneak past it (AC3).
    if (run.paused) {
      run.gate = 'awaiting-approval';
      emit(run);
      return;
    }
    if (readAutoAdvance(run.projectPath)) {
      await advance(run);
    } else {
      run.gate = 'awaiting-approval';
      emit(run);
    }
  };

  const handleErrored = async (run: BridgeRun): Promise<void> => {
    const stage = stageAt(run.pipeline, run.index) ?? '';
    // A human interrupt pins the run at awaiting-approval regardless of how the
    // stage's session then terminates — an `errored` end must not sneak past the
    // pause into rework/escalate any more than an `ended` one can (AC3). Mirrors
    // the `run.paused` guard in `handleEnded`.
    if (run.paused) {
      run.gate = 'awaiting-approval';
      emit(run);
      return;
    }
    const report = readFailureReport(run.projectPath, stage);
    if (report !== null && run.reworkCount < reworkLoopCap) {
      run.reworkCount += 1;
      run.gate = 'reworking';
      await spawnAndEmit(run, 'shipwright', 'build', { prompt: report });
      return;
    }
    run.gate = 'escalated';
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

  const start = (projectPath: string, workItemId?: string): void => {
    const roster = resolveRoster(projectPath);
    if (roster === null) return;
    const firstRole = stageAt(roster.pipeline, 0);
    if (firstRole === null) return;

    const run: BridgeRun = {
      projectPath,
      pipeline: roster.pipeline,
      index: 0,
      currentSessionId: null,
      gate: 'running',
      inbox: [],
      reworkCount: 0,
      paused: false,
    };
    runs.set(projectPath, run);

    void spawnAndEmit(run, firstRole, firstRole, {
      ...(workItemId !== undefined ? { workItemId } : {}),
    });
  };

  const approveGate = (projectPath: string): void => {
    const run = runs.get(projectPath);
    if (run === undefined) return;
    if (run.gate !== 'awaiting-approval') return;
    run.paused = false;
    void advance(run);
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

  return Object.freeze<Bridge>({ start, approveGate, interrupt, onState, getState, getInbox });
}
