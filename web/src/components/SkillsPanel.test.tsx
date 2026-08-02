import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SkillsPanel } from '@/components/SkillsPanel';
import type { RegistryProject, Skill } from '@/lib/ws-client';

function registryProject(overrides: Partial<RegistryProject> = {}): RegistryProject {
  return {
    path: '/abs/repo',
    displayName: 'repo',
    pinned: true,
    uiPrefs: null,
    createdAt: 0,
    ...overrides,
  };
}

function orgSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'plan',
    description: 'Plan a feature',
    scope: 'org',
    ...overrides,
  };
}

function localSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'local-tool',
    description: 'A local-only helper',
    scope: 'local',
    ...overrides,
  };
}

describe('SkillsPanel', () => {
  it('renders org and local groups with each skill in the correct group', () => {
    const project = registryProject();
    render(
      <SkillsPanel
        projects={[project]}
        skills={{ [project.path]: [orgSkill(), localSkill()] }}
        requestSkills={vi.fn()}
      />,
    );

    const orgGroup = screen.getByTestId('skills-group-org');
    const localGroup = screen.getByTestId('skills-group-local');

    expect(within(orgGroup).getByTestId('skill-plan')).toHaveTextContent('plan');
    expect(within(orgGroup).getByTestId('skill-plan')).toHaveTextContent('Plan a feature');
    expect(within(orgGroup).queryByTestId('skill-local-tool')).not.toBeInTheDocument();

    expect(within(localGroup).getByTestId('skill-local-tool')).toHaveTextContent('local-tool');
    expect(within(localGroup).getByTestId('skill-local-tool')).toHaveTextContent(
      'A local-only helper',
    );
    expect(within(localGroup).queryByTestId('skill-plan')).not.toBeInTheDocument();
  });

  it('shows the empty state for a project with no skills', () => {
    const project = registryProject({ path: '/abs/no-skills' });
    render(
      <SkillsPanel projects={[project]} skills={{}} requestSkills={vi.fn()} />,
    );

    expect(screen.getByText('no skills')).toBeInTheDocument();
    expect(screen.queryByTestId('skills-group-org')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skills-group-local')).not.toBeInTheDocument();
  });

  it('requests skills for each pinned project on mount', () => {
    const project = registryProject();
    const requestSkills = vi.fn();
    render(
      <SkillsPanel projects={[project]} skills={{}} requestSkills={requestSkills} />,
    );

    expect(requestSkills).toHaveBeenCalledWith(project.path);
  });
});
