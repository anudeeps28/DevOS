import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Fleet } from '@/components/Fleet';
import type { FleetLane, SessionLane } from '@/lib/fleet-state';

function sessionLane(overrides: Partial<SessionLane> = {}): SessionLane {
  return {
    sessionId: 'sess-1',
    role: 'builder',
    persona: 'Shipwright',
    derivedState: 'running',
    subagents: [],
    ...overrides,
  };
}

function fleetLane(overrides: Partial<FleetLane> = {}): FleetLane {
  return {
    workItemId: 'wi-1',
    projectPath: '/abs/repo',
    sessions: [sessionLane()],
    ...overrides,
  };
}

describe('Fleet', () => {
  it('shows the empty state when there are no lanes', () => {
    render(<Fleet lanes={[]} />);

    expect(screen.getByTestId('fleet-empty')).toBeInTheDocument();
  });

  it('renders a work item lane with its session and persona badge', () => {
    render(<Fleet lanes={[fleetLane()]} />);

    const workItem = screen.getByTestId('fleet-workitem');
    expect(workItem).toHaveAttribute('data-workitem', 'wi-1');

    const session = screen.getByTestId('fleet-session');
    expect(session).toHaveAttribute('data-role', 'builder');
    expect(session).toHaveAttribute('data-derived-state', 'running');
    expect(screen.getByTestId('fleet-persona')).toHaveTextContent('Shipwright');
  });

  it('renders the exact "waiting — plan limit" label for a rate-limited session', () => {
    render(
      <Fleet
        lanes={[fleetLane({ sessions: [sessionLane({ derivedState: 'waiting-on-rate-limit' })] })]}
      />,
    );

    expect(screen.getByTestId('fleet-session')).toHaveTextContent('waiting — plan limit');
  });

  it('nests a distinct subagent level inside the session — never flattened', () => {
    render(
      <Fleet
        lanes={[
          fleetLane({
            sessions: [
              sessionLane({ subagents: [{ id: 'tu-1', label: 'story-executor-agent' }] }),
            ],
          }),
        ]}
      />,
    );

    const session = screen.getByTestId('fleet-session');
    const subagents = screen.getByTestId('fleet-subagents');
    expect(session).toContainElement(subagents);
    expect(subagents).toHaveTextContent('story-executor-agent');
  });

  it('shows "no inner subagents" when a session has none — the level still renders', () => {
    render(<Fleet lanes={[fleetLane({ sessions: [sessionLane({ subagents: [] })] })]} />);

    expect(screen.getByTestId('fleet-subagents')).toHaveTextContent('no inner subagents');
  });
});
