import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NeedsYouInbox } from '@/components/NeedsYouInbox';
import type { BridgeState, PermissionRequest } from '@/lib/ws-client';

function bridgeState(overrides: Partial<BridgeState> = {}): BridgeState {
  return {
    path: '/abs/repo',
    stage: 'implement',
    gate: 'awaiting-approval',
    sessionId: 'sess-1',
    inbox: [],
    ...overrides,
  };
}

describe('NeedsYouInbox', () => {
  it('shows the empty state when there is no bridge state', () => {
    render(<NeedsYouInbox bridgeState={null} onApprove={() => {}} />);

    expect(screen.getByTestId('needs-you-inbox-empty')).toBeInTheDocument();
  });

  it('shows the empty state when the inbox is empty', () => {
    render(<NeedsYouInbox bridgeState={bridgeState({ inbox: [] })} onApprove={() => {}} />);

    expect(screen.getByTestId('needs-you-inbox-empty')).toBeInTheDocument();
  });

  it('renders a parked item with its stage, kind, and reason', () => {
    const state = bridgeState({
      inbox: [{ stage: 'implement', kind: 'question', reason: 'Which approach?', ts: 1700000000000 }],
    });
    render(<NeedsYouInbox bridgeState={state} onApprove={() => {}} />);

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
    render(<NeedsYouInbox bridgeState={state} onApprove={onApprove} />);

    fireEvent.click(screen.getByTestId('needs-you-approve-0'));

    expect(onApprove).toHaveBeenCalledWith('/abs/repo');
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
    render(<NeedsYouInbox bridgeState={null} onApprove={() => {}} permissions={[permission]} />);

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
        bridgeState={null}
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
        bridgeState={null}
        onApprove={() => {}}
        permissions={[permission]}
        onPermissionDecision={onPermissionDecision}
      />,
    );

    fireEvent.click(screen.getByTestId('needs-you-permission-deny-req9'));

    expect(onPermissionDecision).toHaveBeenCalledWith('s1', 'req9', 'deny');
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
    render(<NeedsYouInbox bridgeState={null} onApprove={() => {}} permissions={[permission]} />);

    expect(screen.queryByTestId('needs-you-inbox-empty')).not.toBeInTheDocument();
  });
});
