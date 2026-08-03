import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NeedsYouInbox } from '@/components/NeedsYouInbox';
import type { BridgeState, ForeignNeedsYou, PermissionRequest } from '@/lib/ws-client';

function bridgeState(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    path: '/abs/repo',
    stage: 'implement',
    gate: 'awaiting-approval',
    sessionId: 'sess-1',
    inbox: [],
    reworkCount: 0,
    ...overrides,
  };
}

describe('NeedsYouInbox', () => {
  it('shows the empty state when there is no bridge state', () => {
    render(<NeedsYouInbox bridgeStates={[]} onApprove={() => {}} />);

    expect(screen.getByTestId('needs-you-inbox-empty')).toBeInTheDocument();
  });

  it('shows the empty state when the inbox is empty', () => {
    render(<NeedsYouInbox bridgeStates={[bridgeState({ inbox: [] })]} onApprove={() => {}} />);

    expect(screen.getByTestId('needs-you-inbox-empty')).toBeInTheDocument();
  });

  it('renders a parked item with its stage, kind, and reason', () => {
    const state = bridgeState({
      inbox: [{ stage: 'implement', kind: 'question', reason: 'Which approach?', ts: 1700000000000 }],
    });
    render(<NeedsYouInbox bridgeStates={[state]} onApprove={() => {}} />);

    expect(screen.queryByTestId('needs-you-inbox-empty')).not.toBeInTheDocument();
    const item = screen.getByTestId('needs-you-item-0');
    expect(item).toHaveAttribute('data-kind', 'question');
    expect(item).toHaveTextContent('implement');
    expect(item).toHaveTextContent('Which approach?');
  });

  it('calls onApprove with the bridge state path when Approve is clicked', () => {
    const onApprove = vi.fn();
    const state = bridgeState({
      inbox: [{ stage: 'implement', kind: 'interrupt', reason: 'paused', ts: 1 }],
    });
    render(<NeedsYouInbox bridgeStates={[state]} onApprove={onApprove} />);

    fireEvent.click(screen.getByTestId('needs-you-approve-0'));

    expect(onApprove).toHaveBeenCalledWith('/abs/repo');
  });

  it('surfaces parked items from multiple pinned projects', () => {
    const stateOne = bridgeState({
      path: '/abs/one',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'Which approach?', ts: 1 }],
    });
    const stateTwo = bridgeState({
      path: '/abs/two',
      inbox: [{ stage: 'review', kind: 'interrupt', reason: 'paused', ts: 2 }],
    });
    render(<NeedsYouInbox bridgeStates={[stateOne, stateTwo]} onApprove={() => {}} />);

    expect(screen.getByTestId('needs-you-item-0')).toBeInTheDocument();
    expect(screen.getByTestId('needs-you-item-1')).toBeInTheDocument();
    expect(screen.queryByTestId('needs-you-inbox-empty')).not.toBeInTheDocument();
  });

  it("fires onApprove with the clicked item's own project path", () => {
    const onApprove = vi.fn();
    const stateOne = bridgeState({
      path: '/abs/one',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'Which approach?', ts: 1 }],
    });
    const stateTwo = bridgeState({
      path: '/abs/two',
      inbox: [{ stage: 'review', kind: 'interrupt', reason: 'paused', ts: 2 }],
    });
    render(<NeedsYouInbox bridgeStates={[stateOne, stateTwo]} onApprove={onApprove} />);

    fireEvent.click(screen.getByTestId('needs-you-approve-1'));

    expect(onApprove).toHaveBeenCalledWith('/abs/two');
  });

  it('renders a pending permission request with its title', () => {
    const permission: PermissionRequest = {
      path: '/abs/repo',
      sessionId: 's1',
      requestId: 'req9',
      toolUseId: 'tu-9',
      toolName: 'Write',
      title: 'Write to config.json',
      input: '{"file":"config.json"}',
    };
    render(<NeedsYouInbox bridgeStates={[]} onApprove={() => {}} permissions={[permission]} />);

    const item = screen.getByTestId('needs-you-permission-req9');
    expect(item).toBeInTheDocument();
    expect(item).toHaveTextContent('Write to config.json');
  });

  it('calls onPermissionDecision with "allow" when the Allow button is clicked', () => {
    const onPermissionDecision = vi.fn();
    const permission: PermissionRequest = {
      path: '/abs/repo',
      sessionId: 's1',
      requestId: 'req9',
      toolUseId: 'tu-9',
      toolName: 'Write',
      title: 'Write to config.json',
      input: '{"file":"config.json"}',
    };
    render(
      <NeedsYouInbox
        bridgeStates={[]}
        onApprove={() => {}}
        permissions={[permission]}
        onPermissionDecision={onPermissionDecision}
      />,
    );

    fireEvent.click(screen.getByTestId('needs-you-permission-allow-req9'));

    expect(onPermissionDecision).toHaveBeenCalledWith('s1', 'req9', 'allow');
  });

  it('calls onPermissionDecision with "deny" when the Deny button is clicked', () => {
    const onPermissionDecision = vi.fn();
    const permission: PermissionRequest = {
      path: '/abs/repo',
      sessionId: 's1',
      requestId: 'req9',
      toolUseId: 'tu-9',
      toolName: 'Write',
      title: 'Write to config.json',
      input: '{"file":"config.json"}',
    };
    render(
      <NeedsYouInbox
        bridgeStates={[]}
        onApprove={() => {}}
        permissions={[permission]}
        onPermissionDecision={onPermissionDecision}
      />,
    );

    fireEvent.click(screen.getByTestId('needs-you-permission-deny-req9'));

    expect(onPermissionDecision).toHaveBeenCalledWith('s1', 'req9', 'deny');
  });

  it('calls onPermissionDecision with "allow-always" when the Always allow button is clicked', () => {
    const onPermissionDecision = vi.fn();
    const permission: PermissionRequest = {
      path: '/abs/repo',
      sessionId: 's1',
      requestId: 'req9',
      toolUseId: 'tu-9',
      toolName: 'Write',
      title: 'Write to config.json',
      input: '{"file":"config.json"}',
    };
    render(
      <NeedsYouInbox
        bridgeStates={[]}
        onApprove={() => {}}
        permissions={[permission]}
        onPermissionDecision={onPermissionDecision}
      />,
    );

    const alwaysButton = screen.getByTestId('needs-you-permission-always-req9');
    expect(alwaysButton).toHaveTextContent('Always allow');
    fireEvent.click(alwaysButton);

    expect(onPermissionDecision).toHaveBeenCalledWith('s1', 'req9', 'allow-always');
  });

  it('does not show the empty-state message when permissions are present but the inbox is empty', () => {
    const permission: PermissionRequest = {
      path: '/abs/repo',
      sessionId: 's1',
      requestId: 'req9',
      toolUseId: null,
      toolName: 'Write',
      title: null,
      input: '{}',
    };
    render(<NeedsYouInbox bridgeStates={[]} onApprove={() => {}} permissions={[permission]} />);

    expect(screen.queryByTestId('needs-you-inbox-empty')).not.toBeInTheDocument();
  });

  it('renders a foreign needs-you item with its reason', () => {
    const foreignItem: ForeignNeedsYou = {
      path: '/abs/other',
      sessionId: 'foreign-1',
      kind: 'idle_prompt',
      reason: 'Waiting for input on step 3',
      ts: 1700000000000,
      cleared: false,
    };
    render(<NeedsYouInbox bridgeStates={[]} onApprove={() => {}} foreignItems={[foreignItem]} />);

    const item = screen.getByTestId('needs-you-foreign-foreign-1');
    expect(item).toHaveAttribute('data-kind', 'idle_prompt');
    expect(item).toHaveTextContent('Waiting for input on step 3');
  });

  it('does not show the empty-state message when only foreign items are present', () => {
    const foreignItem: ForeignNeedsYou = {
      path: '/abs/other',
      sessionId: 'foreign-1',
      kind: 'permission_prompt',
      reason: 'needs approval',
      ts: 1700000000000,
      cleared: false,
    };
    render(<NeedsYouInbox bridgeStates={[]} onApprove={() => {}} foreignItems={[foreignItem]} />);

    expect(screen.queryByTestId('needs-you-inbox-empty')).not.toBeInTheDocument();
  });

  it('shows the empty state when inbox, permissions, and foreignItems are all empty', () => {
    render(
      <NeedsYouInbox bridgeStates={[]} onApprove={() => {}} permissions={[]} foreignItems={[]} />,
    );

    expect(screen.getByTestId('needs-you-inbox-empty')).toBeInTheDocument();
  });

  it('renders the notes input and Request-changes button for a question item', () => {
    const state = bridgeState({
      inbox: [{ stage: 'implement', kind: 'question', reason: 'Which approach?', ts: 1 }],
    });
    render(<NeedsYouInbox bridgeStates={[state]} onApprove={() => {}} />);

    expect(screen.getByTestId('needs-you-notes-0')).toBeInTheDocument();
    expect(screen.getByTestId('needs-you-request-changes-0')).toBeInTheDocument();
  });

  it('calls onRequestChanges with the item path and typed notes when clicked', () => {
    const onRequestChanges = vi.fn();
    const state = bridgeState({
      path: '/abs/repo',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'Which approach?', ts: 1 }],
    });
    render(
      <NeedsYouInbox bridgeStates={[state]} onApprove={() => {}} onRequestChanges={onRequestChanges} />,
    );

    fireEvent.change(screen.getByTestId('needs-you-notes-0'), {
      target: { value: 'Please use approach B' },
    });
    fireEvent.click(screen.getByTestId('needs-you-request-changes-0'));

    expect(onRequestChanges).toHaveBeenCalledTimes(1);
    expect(onRequestChanges).toHaveBeenCalledWith('/abs/repo', 'Please use approach B');
  });

  it('still calls onApprove for a question item alongside Request changes', () => {
    const onApprove = vi.fn();
    const state = bridgeState({
      path: '/abs/repo',
      inbox: [{ stage: 'implement', kind: 'question', reason: 'Which approach?', ts: 1 }],
    });
    render(<NeedsYouInbox bridgeStates={[state]} onApprove={onApprove} />);

    fireEvent.click(screen.getByTestId('needs-you-approve-0'));

    expect(onApprove).toHaveBeenCalledWith('/abs/repo');
  });

  it('does not render request-changes controls for a non-question item', () => {
    const state = bridgeState({
      inbox: [{ stage: 'implement', kind: 'interrupt', reason: 'paused', ts: 1 }],
    });
    render(<NeedsYouInbox bridgeStates={[state]} onApprove={() => {}} />);

    expect(screen.queryByTestId('needs-you-notes-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('needs-you-request-changes-0')).not.toBeInTheDocument();
  });
});
