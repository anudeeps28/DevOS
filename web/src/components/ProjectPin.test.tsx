import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GitState,
  RegistryCandidate,
  RegistryProject,
  TrackerState,
} from '@/lib/ws-client';

// ProjectPin calls useProjects() with no injection seam, so we mock the hook
// module and drive its return value per test.
const pin = vi.fn();
const unpin = vi.fn();
const discover = vi.fn();
const requestGitState = vi.fn();
const requestTrackerState = vi.fn();
let projects: readonly RegistryProject[] = [];
let candidates: readonly RegistryCandidate[] = [];
let gitStates: Record<string, GitState> = {};
let trackerStates: Record<string, TrackerState> = {};

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({
    projects,
    pin,
    unpin,
    candidates,
    discover,
    gitStates,
    requestGitState,
    trackerStates,
    requestTrackerState,
  }),
}));

// Imported after the mock so the component picks up the mocked hook.
import { ProjectPin } from '@/components/ProjectPin';

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
    pin.mockReset();
    unpin.mockReset();
    discover.mockReset();
    requestGitState.mockReset();
    requestTrackerState.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls pin with the typed absolute path when Pin is clicked', () => {
    render(<ProjectPin />);

    const input = screen.getByTestId('pin-path-input');
    fireEvent.change(input, { target: { value: '/abs/path/to/project' } });
    fireEvent.click(screen.getByTestId('pin-submit'));

    expect(pin).toHaveBeenCalledWith('/abs/path/to/project');
  });

  it('does not call pin for an empty path', () => {
    render(<ProjectPin />);

    fireEvent.click(screen.getByTestId('pin-submit'));

    expect(pin).not.toHaveBeenCalled();
  });

  it('renders one project-item per provided project', () => {
    projects = [sampleProject('/abs/one'), sampleProject('/abs/two')];
    render(<ProjectPin />);

    const items = screen.getAllByTestId('project-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-path', '/abs/one');
    expect(items[1]).toHaveAttribute('data-path', '/abs/two');
    expect(screen.getByText('/abs/one')).toBeInTheDocument();
  });

  it('calls unpin with the project path when its Unpin button is clicked', () => {
    projects = [sampleProject('/abs/one')];
    render(<ProjectPin />);

    fireEvent.click(screen.getByTestId('unpin-/abs/one'));

    expect(unpin).toHaveBeenCalledWith('/abs/one');
  });

  it('renders a candidate row and pins it with its displayName on click', () => {
    candidates = [sampleCandidate('/abs/cand', 'Cand')];
    render(<ProjectPin />);

    expect(screen.getByTestId('candidate-/abs/cand')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('candidate-pin-/abs/cand'));

    expect(pin).toHaveBeenCalledWith('/abs/cand', { displayName: 'Cand' });
  });

  it('pins a candidate without a displayName option when it has none', () => {
    candidates = [sampleCandidate('/abs/cand', null)];
    render(<ProjectPin />);

    fireEvent.click(screen.getByTestId('candidate-pin-/abs/cand'));

    expect(pin).toHaveBeenCalledWith('/abs/cand', undefined);
  });

  it('hides a candidate whose path is already pinned', () => {
    projects = [sampleProject('/abs/dup')];
    candidates = [sampleCandidate('/abs/dup'), sampleCandidate('/abs/new')];
    render(<ProjectPin />);

    expect(screen.queryByTestId('candidate-/abs/dup')).not.toBeInTheDocument();
    expect(screen.getByTestId('candidate-/abs/new')).toBeInTheDocument();
  });

  it('calls discover when the refresh button is clicked', () => {
    render(<ProjectPin />);

    fireEvent.click(screen.getByTestId('discover-refresh'));

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and no project-items when nothing is pinned', () => {
    projects = [];
    render(<ProjectPin />);

    expect(screen.getByTestId('discovery-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('project-item')).toHaveLength(0);
  });

  it('hides the empty state and renders project-items when projects exist', () => {
    projects = [sampleProject('/abs/one')];
    render(<ProjectPin />);

    expect(screen.queryByTestId('discovery-empty')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('project-item')).toHaveLength(1);
  });

  describe('git status line', () => {
    it('shows the loading affordance when no snapshot has arrived yet', () => {
      projects = [sampleProject('/abs/one')];
      // gitStates intentionally empty → undefined snapshot for this path.
      render(<ProjectPin />);

      const line = screen.getByTestId('git-state-/abs/one');
      expect(line).toHaveAttribute('data-isrepo', 'null');
      expect(line).toHaveTextContent('…');
    });

    it('renders branch, no dirty marker, and no arrows for a clean no-upstream repo', () => {
      projects = [sampleProject('/abs/one')];
      gitStates = { '/abs/one': sampleGitState('/abs/one') };
      render(<ProjectPin />);

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
      render(<ProjectPin />);

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
      render(<ProjectPin />);

      const line = screen.getByTestId('git-state-/abs/one');
      expect(line).toHaveAttribute('data-isrepo', 'false');
      expect(line).toHaveTextContent('not a git repo');
    });

    it('renders "detached" for a detached HEAD', () => {
      projects = [sampleProject('/abs/one')];
      gitStates = {
        '/abs/one': sampleGitState('/abs/one', { detached: true, branch: null }),
      };
      render(<ProjectPin />);

      const line = screen.getByTestId('git-state-/abs/one');
      expect(line).toHaveTextContent('detached');
    });

    it('requests a fresh git-state for each pinned project on mount', () => {
      projects = [sampleProject('/abs/one'), sampleProject('/abs/two')];
      render(<ProjectPin />);

      expect(requestGitState).toHaveBeenCalledWith('/abs/one');
      expect(requestGitState).toHaveBeenCalledWith('/abs/two');
    });
  });

  describe('next task line', () => {
    it('shows the loading affordance when no snapshot has arrived yet', () => {
      projects = [sampleProject('/abs/one')];
      // trackerStates intentionally empty → undefined snapshot for this path.
      render(<ProjectPin />);

      const line = screen.getByTestId('tracker-state-/abs/one');
      expect(line).toHaveAttribute('data-reachable', 'null');
      expect(line).toHaveTextContent('…');
    });

    it('renders the next task title for a reachable snapshot with a task', () => {
      projects = [sampleProject('/abs/one')];
      trackerStates = { '/abs/one': sampleTrackerState('/abs/one') };
      render(<ProjectPin />);

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
      render(<ProjectPin />);

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
      render(<ProjectPin />);

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
      render(<ProjectPin />);

      const line = screen.getByTestId('tracker-state-/abs/one');
      expect(line).toHaveAttribute('data-reachable', 'false');
      expect(line).toHaveTextContent('tracker unreachable');
    });

    it('requests a fresh tracker-state for each pinned project on mount', () => {
      projects = [sampleProject('/abs/one'), sampleProject('/abs/two')];
      render(<ProjectPin />);

      expect(requestTrackerState).toHaveBeenCalledWith('/abs/one');
      expect(requestTrackerState).toHaveBeenCalledWith('/abs/two');
    });
  });
});
