import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegistryProject } from '@/lib/ws-client';

// ProjectPin calls useProjects() with no injection seam, so we mock the hook
// module and drive its return value per test.
const pin = vi.fn();
const unpin = vi.fn();
let projects: readonly RegistryProject[] = [];

vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => ({ projects, pin, unpin }),
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

describe('ProjectPin', () => {
  beforeEach(() => {
    projects = [];
    pin.mockReset();
    unpin.mockReset();
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
});
