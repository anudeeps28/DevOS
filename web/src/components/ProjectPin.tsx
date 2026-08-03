import { useEffect, useState } from 'react';

import type { UseProjectsResult } from '@/hooks/useProjects';
import { resolveStage } from '@/lib/lifecycle';
import type { GitState, LifecycleSignals, SessionState, TrackerState } from '@/lib/ws-client';
import { cn } from '@/lib/utils';

/** Default role used by the card's one-click spawn (full role selection is a later task). */
const DEFAULT_SPAWN_ROLE = 'builder';

/** Stringify a nullable numeric field for a `data-*` attribute. */
function attrNum(value: number | null): string {
  return value === null ? 'null' : String(value);
}

/**
 * Compact git-status line for one pinned row. Render-only:
 *  - undefined snapshot → a subtle loading affordance,
 *  - not a repo → muted "not a git repo",
 *  - detached HEAD → "detached",
 *  - else the branch name, a dirty marker when dirty, and `↑{ahead} ↓{behind}`
 *    only when ahead/behind are non-null (a no-upstream branch shows no arrows).
 */
function GitStatusLine({ path, state }: { path: string; state: GitState | undefined }): JSX.Element {
  if (state === undefined) {
    return (
      <span
        data-testid={`git-state-${path}`}
        data-isrepo="null"
        className="font-mono text-xs text-muted-foreground/60"
      >
        …
      </span>
    );
  }

  const showArrows = state.ahead !== null && state.behind !== null;

  return (
    <span
      data-testid={`git-state-${path}`}
      data-isrepo={String(state.isRepo)}
      data-branch={state.branch ?? 'null'}
      data-dirty={String(state.dirty)}
      data-ahead={attrNum(state.ahead)}
      data-behind={attrNum(state.behind)}
      className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
    >
      {!state.isRepo ? (
        <span className="italic">not a git repo</span>
      ) : state.detached ? (
        <span>detached</span>
      ) : (
        <>
          <span className="text-foreground">{state.branch ?? 'null'}</span>
          {state.dirty && (
            <span title="uncommitted changes" className="text-amber-500">
              ●
            </span>
          )}
          {showArrows && (
            <span className="tabular-nums">
              ↑{state.ahead} ↓{state.behind}
            </span>
          )}
        </>
      )}
    </span>
  );
}

/**
 * Compact next-task line for one pinned row. Render-only:
 *  - undefined snapshot → a subtle loading affordance,
 *  - unreachable tracker → muted italic "tracker unreachable",
 *  - reachable but no tracker configured → muted italic "no tracker" (distinct from
 *    a genuinely empty backlog — the backend is unknown, not empty),
 *  - reachable with no open task → muted "no open tasks",
 *  - reachable with a next task → the task title.
 */
function NextTaskLine({
  path,
  state,
}: {
  path: string;
  state: TrackerState | undefined;
}): JSX.Element {
  if (state === undefined) {
    return (
      <span
        data-testid={`tracker-state-${path}`}
        data-reachable="null"
        className="text-xs text-muted-foreground/60"
      >
        …
      </span>
    );
  }

  if (!state.reachable) {
    return (
      <span
        data-testid={`tracker-state-${path}`}
        data-reachable="false"
        className="text-xs italic text-muted-foreground"
      >
        tracker unreachable
      </span>
    );
  }

  if (state.tracker === null) {
    return (
      <span
        data-testid={`tracker-state-${path}`}
        data-reachable="true"
        data-tracker="null"
        data-title="null"
        className="text-xs italic text-muted-foreground"
      >
        no tracker
      </span>
    );
  }

  if (state.nextTask === null) {
    return (
      <span
        data-testid={`tracker-state-${path}`}
        data-reachable="true"
        data-title="null"
        className="text-xs text-muted-foreground"
      >
        no open tasks
      </span>
    );
  }

  return (
    <span
      data-testid={`tracker-state-${path}`}
      data-reachable="true"
      data-title={state.nextTask.title}
      className="truncate text-xs text-foreground"
    >
      {state.nextTask.title}
    </span>
  );
}

/**
 * Compact lifecycle stage badge for one pinned row. Render-only:
 *  - no server signals yet → a subtle loading affordance,
 *  - else the one-word stage (New / Decide / Define / Build / Ship).
 * The stage is composed on the CLIENT via resolveStage from the server signals PLUS
 * this card's already-fetched tracker state (ARCHITECTURE §9.2/§9.6: reuses the
 * per-card reads). Its sticky high-water behavior is structural — max(precedence) over
 * durable signals, not a stored value.
 */
function StageBadge({
  path,
  signals,
  trackerState,
}: {
  path: string;
  signals: LifecycleSignals | undefined;
  trackerState: TrackerState | undefined;
}): JSX.Element {
  if (signals === undefined) {
    return (
      <span
        data-testid={`lifecycle-state-${path}`}
        data-stage="null"
        className="text-xs text-muted-foreground/60"
      >
        …
      </span>
    );
  }

  const stage = resolveStage(signals, trackerState);

  return (
    <span
      data-testid={`lifecycle-state-${path}`}
      data-stage={stage}
      className="w-fit rounded-full border border-border px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
    >
      {stage}
    </span>
  );
}

/**
 * Minimal owned-session control for one pinned card. Render-only (state lives in the
 * hook): a one-click "Spawn" button that starts a session for this project, plus a
 * running-count indicator. Deliberately thin — NO transcript, steering, or permission
 * UI (each is a separate downstream M2 task).
 */
function SessionControl({
  path,
  sessions,
  onSpawn,
}: {
  path: string;
  sessions: readonly SessionState[] | undefined;
  onSpawn: (path: string, role: string) => void;
}): JSX.Element {
  const runningCount = (sessions ?? []).filter((s) => s.status === 'running').length;

  return (
    <div
      data-testid={`session-control-${path}`}
      data-running={String(runningCount)}
      className="flex items-center justify-between gap-2"
    >
      <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
        {runningCount > 0 ? `${runningCount} running` : 'no sessions'}
      </span>
      <button
        data-testid={`session-spawn-${path}`}
        type="button"
        onClick={() => onSpawn(path, DEFAULT_SPAWN_ROLE)}
        className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        Spawn
      </button>
    </div>
  );
}

/**
 * Static mini-fleet placeholder for one pinned card. Render-only stub — NO fleet
 * plumbing, no hook, no WS frame (scope guard). Shows a muted "fleet" label and a
 * couple of skeleton dots so the card reserves a slot for the future live fleet view.
 */
function MiniFleetPlaceholder({ path }: { path: string }): JSX.Element {
  return (
    <div
      data-testid={`fleet-placeholder-${path}`}
      data-fleet="placeholder"
      className="flex items-center gap-1.5"
    >
      <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
        fleet
      </span>
      <span className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25" />
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25" />
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/25" />
      </span>
    </div>
  );
}

/**
 * The slice of the single app-level useProjects() result this component needs.
 * ProjectPin is presentational: the parent (App) owns the one hook instance —
 * and therefore the one WS client — and feeds state + action callbacks down.
 */
export type ProjectPinProps = Pick<
  UseProjectsResult,
  | 'projects'
  | 'candidates'
  | 'pin'
  | 'unpin'
  | 'discover'
  | 'gitStates'
  | 'requestGitState'
  | 'trackerStates'
  | 'requestTrackerState'
  | 'lifecycleSignals'
  | 'requestLifecycleSignals'
  | 'sessions'
  | 'spawnSession'
> & { readonly onAssignWork: (path: string, workItemId: string) => void };

/**
 * Project discovery + pin management. Renders three regions:
 *  - a "Discovered" section (refresh + candidate rows not yet pinned),
 *  - a "Pinned" grid of pinned projects (each with an Unpin button),
 *  - an empty state when nothing is pinned.
 * Also keeps the manual pin-by-typed-path affordance as a secondary path.
 * Render-only: all state lives in the parent's useProjects hook; no local mutation.
 */
export function ProjectPin({
  projects,
  candidates,
  pin,
  unpin,
  discover,
  gitStates,
  requestGitState,
  trackerStates,
  requestTrackerState,
  lifecycleSignals,
  requestLifecycleSignals,
  sessions,
  spawnSession,
  onAssignWork,
}: ProjectPinProps) {
  const [path, setPath] = useState('');

  // Fresh-per-(re)mount: request a git-state read for each pinned project when
  // the pinned list changes. The hook already requests on connect/projects-change;
  // this covers a component remount over an already-open socket.
  const pinnedKey = projects.map((project) => project.path).join('\n');
  useEffect(() => {
    for (const project of projects) {
      requestGitState(project.path);
      requestTrackerState(project.path);
      requestLifecycleSignals(project.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedKey]);

  const trimmed = path.trim();
  const canPin = trimmed.length > 0;

  const handlePin = (): void => {
    if (!canPin) return;
    pin(trimmed);
    setPath('');
  };

  const pinnedPaths = new Set(projects.map((project) => project.path));
  const unpinnedCandidates = candidates.filter(
    (candidate) => !pinnedPaths.has(candidate.path),
  );

  return (
    <div className={cn('flex w-full max-w-md flex-col gap-4')}>
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Discovered
          </span>
          <button
            data-testid="discover-refresh"
            type="button"
            onClick={() => discover()}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Refresh
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {unpinnedCandidates.map((candidate) => (
            <li
              key={candidate.path}
              data-testid={`candidate-${candidate.path}`}
              data-path={candidate.path}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5"
            >
              <span className="truncate font-mono text-sm">
                {candidate.displayName ?? candidate.path}
              </span>
              <button
                data-testid={`candidate-pin-${candidate.path}`}
                type="button"
                onClick={() =>
                  pin(
                    candidate.path,
                    candidate.displayName
                      ? { displayName: candidate.displayName }
                      : undefined,
                  )
                }
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Pin
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Projects
        </span>
        <div className="flex gap-2">
          <input
            data-testid="pin-path-input"
            type="text"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/absolute/path/to/project"
            className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm"
          />
          <button
            data-testid="pin-submit"
            type="button"
            onClick={handlePin}
            disabled={!canPin}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Pin
          </button>
        </div>
        {projects.length === 0 ? (
          <p
            data-testid="discovery-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
          >
            No projects pinned yet — refresh discovery to find projects.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {projects.map((project) => (
              <li
                key={project.path}
                data-testid="project-item"
                data-path={project.path}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate font-mono text-sm">{project.path}</span>
                  <button
                    data-testid={`unpin-${project.path}`}
                    type="button"
                    onClick={() => unpin(project.path)}
                    className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Unpin
                  </button>
                </div>
                <MiniFleetPlaceholder path={project.path} />
                <SessionControl
                  path={project.path}
                  sessions={sessions[project.path]}
                  onSpawn={spawnSession}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <GitStatusLine path={project.path} state={gitStates[project.path]} />
                  <NextTaskLine path={project.path} state={trackerStates[project.path]} />
                  <StageBadge
                    path={project.path}
                    signals={lifecycleSignals[project.path]}
                    trackerState={trackerStates[project.path]}
                  />
                </div>
                {(() => {
                  const trackerState = trackerStates[project.path];
                  const eligible =
                    trackerState !== undefined &&
                    trackerState.reachable === true &&
                    trackerState.tracker !== null &&
                    trackerState.nextTask !== null;
                  return (
                    <button
                      data-testid={`assign-work-${project.path}`}
                      type="button"
                      data-eligible={String(eligible)}
                      disabled={!eligible}
                      onClick={() => {
                        const nextTask = trackerState?.nextTask;
                        if (nextTask) onAssignWork(project.path, nextTask.id);
                      }}
                      className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      Assign work
                    </button>
                  );
                })()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
