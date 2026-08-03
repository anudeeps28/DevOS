import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import App from '@/App';
import type { UseProjectsResult } from '@/hooks/useProjects';
import type { RegistryProject, TrackerState } from '@/lib/ws-client';

// App is the ONLY place that wires ProjectPin's onAssignWork to the
// useProjects() hook's bridgeStart + local `selected` navigation state — the
// ProjectPin test covers click → onAssignWork, and the useProjects test
// covers bridgeStart → sendBridgeStart, but the handler body connecting the
// two lives only here. Mock the hook (and useHeartbeat, so mount doesn't open
// a real WS client) and drive the real rendered ProjectPin button.
vi.mock('@/hooks/useHeartbeat', () => ({
  useHeartbeat: () => ({ status: 'connected' as const, heartbeat: null }),
}));

const bridgeStart = vi.fn();

/** A type-complete default UseProjectsResult stub; tests override only what they need. */
function defaultProjectsResult(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
  return {
    projects: [],
    candidates: [],
    pin: vi.fn(),
    unpin: vi.fn(),
    discover: vi.fn(),
    gitStates: {},
    requestGitState: vi.fn(),
    skills: {},
    requestSkills: vi.fn(),
    trackerStates: {},
    requestTrackerState: vi.fn(),
    lifecycleSignals: {},
    requestLifecycleSignals: vi.fn(),
    sessions: {},
    sessionPersonas: {},
    requestSessionPersonas: vi.fn(),
    rosterTimelines: {},
    requestRosterTimeline: vi.fn(),
    workItemSessions: {},
    requestWorkItemSessions: vi.fn(),
    bridgeStates: {},
    approveGate: vi.fn(),
    requestChanges: vi.fn(),
    spawnSession: vi.fn(),
    bridgeStart,
    transcripts: {},
    requestTranscript: vi.fn(),
    sendSessionInput: vi.fn(),
    interruptSession: vi.fn(),
    pendingPermissions: {},
    resolvePermission: vi.fn(),
    foreignNeedsYou: [],
    hookBusConnected: false,
    costToday: null,
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

function sampleTrackerState(path: string): TrackerState {
  return {
    path,
    reachable: true,
    tracker: 'todoist',
    nextTask: { id: 'task-1', title: 'Wire the gateway', priority: 4, url: null },
  };
}

vi.mock('@/hooks/useProjects', () => ({
  useProjects: vi.fn(),
}));

describe('App — assign work wiring', () => {
  it('clicking Assign work calls bridgeStart(path, nextTaskId) AND navigates to Work-item Detail', async () => {
    const { useProjects } = await import('@/hooks/useProjects');
    const path = '/abs/one';
    vi.mocked(useProjects).mockReturnValue(
      defaultProjectsResult({
        projects: [sampleProject(path)],
        trackerStates: { [path]: sampleTrackerState(path) },
      }),
    );

    render(<App />);

    const button = screen.getByTestId(`assign-work-${path}`);
    fireEvent.click(button);

    expect(bridgeStart).toHaveBeenCalledTimes(1);
    expect(bridgeStart).toHaveBeenCalledWith(path, 'task-1');

    const detail = screen.getByTestId('work-item-detail');
    expect(detail).toHaveAttribute('data-workitem', 'task-1');
  });
});
