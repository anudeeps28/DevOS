import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectPin } from '@/components/ProjectPin';
import type {
  GitState,
  LifecycleSignals,
  RegistryCandidate,
  RegistryProject,
  SessionState,
  TrackerState,
} from '@/lib/ws-client';

// ProjectPin is presentational: the parent owns the single useProjects()
// instance and feeds state + callbacks as props. Tests drive those props
// directly via the mutable fixtures below and renderPin().
const pin = vi.fn();
const unpin = vi.fn();
const discover = vi.fn();
const requestGitState = vi.fn();
const requestTrackerState = vi.fn();
const requestLifecycleSignals = vi.fn();
const spawnSession = vi.fn();
let projects: readonly RegistryProject[] = [];
let candidates: readonly RegistryCandidate[] = [];
let gitStates: Record<string, GitState> = {};
let trackerStates: Record<string, TrackerState> = {};
let lifecycleSignals: Record<string, LifecycleSignals> = {};
let sessions: Record<string, readonly SessionState[]> = {};

/** Render ProjectPin with the current fixture state as props. */
function renderPin() {
  return render(
    <ProjectPin
      projects={projects}
      candidates={candidates}
      pin={pin}
      unpin={unpin}
      discover={discover}
      gitStates={gitStates}
      requestGitState={requestGitState}
      trackerStates={trackerStates}
      requestTrackerState={requestTrackerState}
      lifecycleSignals={lifecycleSignals}
      requestLifecycleSignals={requestLifecycleSignals}
      sessions={sessions}
      spawnSession={spawnSession}
    />,
  );
}

function makeSignals(overrides: Partial<LifecycleSignals> = {}): LifecycleSignals {
  return {
    hasDecideDocs: false,
    hasDefineDocs: false,
    hasStartedStory: false,
    hasFeatureBranchCommits: false,
    hasReleaseTags: false,
    ...overrides,
  };
}

function sampleProject(path: string): RegistryProject {
  return {
    path,
    displayName: null,
    pinned: true,
    uiPrefs: null,
    createdAt: 1700000000000,
  };
}

function sampleCandidate(
  path: string,
  displayName: string | null = null,
): RegistryCandidate {
  return { path, displayName, hasClaudeInstall: true };
}

function sampleGitState(path: string, overrides: Partial<GitState> = {}): GitState {
  return {
    path,
    isRepo: true,
    branch: 'main',
    detached: false,
    dirty: false,
    ahead: null,
    behind: null,
    upstream: null,
    ...overrides,
  };
}

function sampleTrackerState(
  path: string,
  overrides: Partial<TrackerState> = {},
): TrackerState {
  return {
    path,
    reachable: true,
    tracker: 'todoist',
    nextTask: { id: '1', title: 'Wire the gateway', priority: 4, url: null },
    ...overrides,
  };
}

describe('ProjectPin', () => {
  beforeEach(() => {
    projects = [];
    candidates = [];
    gitStates = {};
    trackerStates = {};
    lifecycleSignals = {};
    sessions = {};
    pin.mockReset();
    unpin.mockReset();
    discover.mockReset();
    requestGitState.mockReset();
    requestTrackerState.mockReset();
    requestLifecycleSignals.mockReset();
    spawnSession.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls pin with the typed absolute path when Pin is clicked', () => {
    renderPin();

    const input = screen.getByTestId('pin-path-input');
    fireEvent.change(input, { target: { value: '/abs/path/to/project' } });
    fireEvent.click(screen.getByTestId('pin-submit'));

    expect(pin).toHaveBeenCalledWith('/abs/path/to/project');
  });

  it('does not call pin for an empty path', () => {
    renderPin();

    fireEvent.click(screen.getByTestId('pin-submit'));

    expect(pin).not.toHaveBeenCalled();
  });

  it('renders one project-item per provided project', () => {
    projects = [sampleProject('/abs/one'), sampleProject('/abs/two')];
    renderPin();

    const items = screen.getAllByTestId('project-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-path', '/abs/one');
    expect(items[1]).toHaveAttribute('data-path', '/abs/two');
    expect(screen.getByText('/abs/one')).toBeInTheDocument();
  });

  it('calls unpin with the project path when its Unpin button is clicked', () => {
    projects = [sampleProject('/abs/one')];
    renderPin();

    fireEvent.click(screen.getByTestId('unpin-/abs/one'));

    expect(unpin).toHaveBeenCalledWith('/abs/one');
  });

  it('renders a candidate row and pins it with its displayName on click', () => {
    candidates = [sampleCandidate('/abs/cand', 'Cand')];
    renderPin();

    expect(screen.getByTestId('candidate-/abs/cand')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('candidate-pin-/abs/cand'));

    expect(pin).toHaveBeenCalledWith('/abs/cand', { displayName: 'Cand' });
  });

  it('pins a candidate without a displayName option when it has none', () => {
    candidates = [sampleCandidate('/abs/cand', null)];
    renderPin();

    fireEvent.click(screen.getByTestId('candidate-pin-/abs/cand'));

    expect(pin).toHaveBeenCalledWith('/abs/cand', undefined);
  });

  it('hides a candidate whose path is already pinned', () => {
    projects = [sampleProject('/abs/dup')];
    candidates = [sampleCandidate('/abs/dup'), sampleCandidate('/abs/new')];
    renderPin();

    expect(screen.queryByTestId('candidate-/abs/dup')).not.toBeInTheDocument();
    expect(screen.getByTestId('candidate-/abs/new')).toBeInTheDocument();
  });

  it('calls discover when the refresh button is clicked', () => {
    renderPin();

    fireEvent.click(screen.getByTestId('discover-refresh'));

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and no project-items when nothing is pinned', () => {
    projects = [];
    renderPin();

    expect(screen.getByTestId('discovery-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('project-item')).toHaveLength(0);
  });

  it('hides the empty state and renders project-items when projects exist', () => {
    projects = [sampleProject('/abs/one')];
    renderPin();

    expect(screen.queryByTestId('discovery-empty')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('project-item')).toHaveLength(1);
  });

  describe('git status line', () => {
    it('shows the loading affordance when no snapshot has arrived yet', () => {
      projects = [sampleProject('/abs/one')];
      // gitStates intentionally empty → undefined snapshot for this path.
      renderPin();

      const line = screen.getByTestId('git-state-/abs/one');
      expect(line).toHaveAttribute('data-isrepo', 'null');
      expect(line).toHaveTextContent('…');
    });

    it('renders branch, no dirty marker, and no arrows for a clean no-upstream repo', () => {
      projects = [sampleProject('/abs/one')];
      gitStates = { '/abs/one': sampleGitState('/abs/one') };
      renderPin();

      const line = screen.getByTestId('git-state-/abs/one');
      expect(line).toHaveAttribute('data-isrepo', 'true');
      expect(line).toHaveAttribute('data-branch', 'main');
      expect(line).toHaveAttribute('data-dirty', 'false');
      // No upstream → null ahead/behind, and NO arrows rendered (never ↑0 ↓0).
      expect(line).toHaveAttribute('data-ahead', 'null');
      expect(line).toHaveAttribute('data-behind', 'null');
      expect(line).toHaveTextContent('main');
      expect(line).not.toHaveTextContent('↑');
    });

    it('renders the dirty marker and ahead/behind arrows when tracking an upstream', () => {
      projects = [sampleProject('/abs/one')];
      gitStates = {
        '/abs/one': sampleGitState('/abs/one', {
          branch: 'feat',
          dirty: true,
          ahead: 2,
          behind: 3,
          upstream: 'origin/feat',
        }),
      };
      renderPin();

      const line = screen.getByTestId('git-state-/abs/one');
      expect(line).toHaveAttribute('data-dirty', 'true');
      expect(line).toHaveAttribute('data-ahead', '2');
      expect(line).toHaveAttribute('data-behind', '3');
      expect(line).toHaveTextContent('feat');
      expect(line).toHaveTextContent('↑2 ↓3');
    });

    it('renders "not a git repo" for a non-repo path', () => {
      projects = [sampleProject('/abs/one')];
      gitStates = { '/abs/one': sampleGitState('/abs/one', { isRepo: false, branch: null }) };
      renderPin();

      const line = screen.getByTestId('git-state-/abs/one');
      expect(line).toHaveAttribute('data-isrepo', 'false');
      expect(line).toHaveTextContent('not a git repo');
    });

    it('renders "detached" for a detached HEAD', () => {
      projects = [sampleProject('/abs/one')];
      gitStates = {
        '/abs/one': sampleGitState('/abs/one', { detached: true, branch: null }),
      };
      renderPin();

      const line = screen.getByTestId('git-state-/abs/one');
      expect(line).toHaveTextContent('detached');
    });

    it('requests a fresh git-state for each pinned project on mount', () => {
      projects = [sampleProject('/abs/one'), sampleProject('/abs/two')];
      renderPin();

      expect(requestGitState).toHaveBeenCalledWith('/abs/one');
      expect(requestGitState).toHaveBeenCalledWith('/abs/two');
    });
  });

  describe('next task line', () => {
    it('shows the loading affordance when no snapshot has arrived yet', () => {
      projects = [sampleProject('/abs/one')];
      // trackerStates intentionally empty → undefined snapshot for this path.
      renderPin();

      const line = screen.getByTestId('tracker-state-/abs/one');
      expect(line).toHaveAttribute('data-reachable', 'null');
      expect(line).toHaveTextContent('…');
    });

    it('renders the next task title for a reachable snapshot with a task', () => {
      projects = [sampleProject('/abs/one')];
      trackerStates = { '/abs/one': sampleTrackerState('/abs/one') };
      renderPin();

      const line = screen.getByTestId('tracker-state-/abs/one');
      expect(line).toHaveAttribute('data-reachable', 'true');
      expect(line).toHaveAttribute('data-title', 'Wire the gateway');
      expect(line).toHaveTextContent('Wire the gateway');
    });

    it('renders "no open tasks" for a reachable snapshot with no next task', () => {
      projects = [sampleProject('/abs/one')];
      trackerStates = {
        '/abs/one': sampleTrackerState('/abs/one', { nextTask: null }),
      };
      renderPin();

      const line = screen.getByTestId('tracker-state-/abs/one');
      expect(line).toHaveAttribute('data-reachable', 'true');
      expect(line).toHaveAttribute('data-title', 'null');
      expect(line).toHaveTextContent('no open tasks');
    });

    it('renders "no tracker" (distinct from empty) when reachable but no tracker configured', () => {
      projects = [sampleProject('/abs/one')];
      trackerStates = {
        '/abs/one': sampleTrackerState('/abs/one', { tracker: null, nextTask: null }),
      };
      renderPin();

      const line = screen.getByTestId('tracker-state-/abs/one');
      expect(line).toHaveAttribute('data-reachable', 'true');
      expect(line).toHaveAttribute('data-tracker', 'null');
      expect(line).toHaveTextContent('no tracker');
    });

    it('renders "tracker unreachable" for an unreachable snapshot', () => {
      projects = [sampleProject('/abs/one')];
      trackerStates = {
        '/abs/one': sampleTrackerState('/abs/one', {
          reachable: false,
          tracker: null,
          nextTask: null,
        }),
      };
      renderPin();

      const line = screen.getByTestId('tracker-state-/abs/one');
      expect(line).toHaveAttribute('data-reachable', 'false');
      expect(line).toHaveTextContent('tracker unreachable');
    });

    it('requests a fresh tracker-state for each pinned project on mount', () => {
      projects = [sampleProject('/abs/one'), sampleProject('/abs/two')];
      renderPin();

      expect(requestTrackerState).toHaveBeenCalledWith('/abs/one');
      expect(requestTrackerState).toHaveBeenCalledWith('/abs/two');
    });
  });

  describe('lifecycle stage badge', () => {
    it('shows the loading affordance when no signals have arrived yet', () => {
      projects = [sampleProject('/abs/one')];
      // lifecycleSignals intentionally empty → undefined snapshot for this path.
      renderPin();

      const badge = screen.getByTestId('lifecycle-state-/abs/one');
      expect(badge).toHaveAttribute('data-stage', 'null');
      expect(badge).toHaveTextContent('…');
    });

    it('derives and renders the stage from signals (a started story → Build)', () => {
      projects = [sampleProject('/abs/one')];
      lifecycleSignals = { '/abs/one': makeSignals({ hasStartedStory: true }) };
      renderPin();

      const badge = screen.getByTestId('lifecycle-state-/abs/one');
      expect(badge).toHaveAttribute('data-stage', 'Build');
      expect(badge).toHaveTextContent('Build');
    });

    it('derives each of the five stages from the signal that produces it', () => {
      const cases: Array<{ stage: string; signals: LifecycleSignals }> = [
        { stage: 'New', signals: makeSignals() },
        { stage: 'Decide', signals: makeSignals({ hasDecideDocs: true }) },
        { stage: 'Define', signals: makeSignals({ hasDefineDocs: true }) },
        { stage: 'Build', signals: makeSignals({ hasStartedStory: true }) },
        { stage: 'Ship', signals: makeSignals({ hasReleaseTags: true }) },
      ];
      for (const { stage, signals } of cases) {
        projects = [sampleProject('/abs/one')];
        lifecycleSignals = { '/abs/one': signals };
        const { unmount } = renderPin();
        const badge = screen.getByTestId('lifecycle-state-/abs/one');
        expect(badge).toHaveAttribute('data-stage', stage);
        expect(badge).toHaveTextContent(stage);
        unmount();
      }
    });

    it('composes the stage with the card tracker-state (a wayfinder:map task → Decide)', () => {
      projects = [sampleProject('/abs/one')];
      lifecycleSignals = { '/abs/one': makeSignals() };
      trackerStates = {
        '/abs/one': sampleTrackerState('/abs/one', {
          nextTask: { id: 'wayfinder:map:x', title: 'Map', priority: 4, url: null },
        }),
      };
      renderPin();

      const badge = screen.getByTestId('lifecycle-state-/abs/one');
      expect(badge).toHaveAttribute('data-stage', 'Decide');
    });

    it('requests fresh lifecycle-signals for each pinned project on mount', () => {
      projects = [sampleProject('/abs/one'), sampleProject('/abs/two')];
      renderPin();

      expect(requestLifecycleSignals).toHaveBeenCalledWith('/abs/one');
      expect(requestLifecycleSignals).toHaveBeenCalledWith('/abs/two');
    });
  });

  describe('session control', () => {
    function sampleSession(id: string, path: string, status = 'running'): SessionState {
      return { id, projectPath: path, role: 'shipwright', status, sdkSessionId: null };
    }

    it('shows "no sessions" when none are running for the project', () => {
      projects = [sampleProject('/abs/one')];
      renderPin();

      const control = screen.getByTestId('session-control-/abs/one');
      expect(control).toHaveAttribute('data-running', '0');
      expect(control).toHaveTextContent('no sessions');
    });

    it('counts only running sessions in the indicator', () => {
      projects = [sampleProject('/abs/one')];
      sessions = {
        '/abs/one': [
          sampleSession('a', '/abs/one', 'running'),
          sampleSession('b', '/abs/one', 'ended'),
          sampleSession('c', '/abs/one', 'running'),
        ],
      };
      renderPin();

      const control = screen.getByTestId('session-control-/abs/one');
      expect(control).toHaveAttribute('data-running', '2');
      expect(control).toHaveTextContent('2 running');
    });

    it('fires spawnSession with the default role on click', () => {
      projects = [sampleProject('/abs/one')];
      renderPin();

      fireEvent.click(screen.getByTestId('session-spawn-/abs/one'));

      expect(spawnSession).toHaveBeenCalledWith('/abs/one', 'shipwright');
    });
  });
});
