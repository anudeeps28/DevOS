import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegistryCandidate, RegistryProject } from '@/lib/ws-client';

// ProjectPin calls useProjects() with no injection seam, so we mock the hook
// module and drive its return value per test.
const pin = vi.fn();
const unpin = vi.fn();
const discover = vi.fn();
let projects: readonly RegistryProject[] = [];
let candidates: readonly RegistryCandidate[] = [];

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ projects, pin, unpin, candidates, discover }),
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

describe('ProjectPin', () => {
  beforeEach(() => {
    projects = [];
    candidates = [];
    pin.mockReset();
    unpin.mockReset();
    discover.mockReset();
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
});
