import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TeamRoom } from '@/components/TeamRoom';
import type { PermissionRequest, SessionState, TranscriptEvent } from '@/lib/ws-client';

/** Render TeamRoom, defaulting the two sender props so tests opt in only when needed. */
function renderRoom(
  sessions: Record<string, readonly SessionState[]>,
  transcripts: Record<string, readonly TranscriptEvent[]>,
  senders: {
    sendSessionInput?: (sessionId: string, text: string) => void;
    interruptSession?: (sessionId: string) => void;
    pendingPermissions?: Record<string, readonly PermissionRequest[]>;
    resolvePermission?: (sessionId: string, requestId: string, decision: 'allow' | 'deny') => void;
  } = {},
): void {
  render(
    <TeamRoom
      sessions={sessions}
      transcripts={transcripts}
      sendSessionInput={senders.sendSessionInput ?? (() => {})}
      interruptSession={senders.interruptSession ?? (() => {})}
      {...(senders.pendingPermissions !== undefined
        ? { pendingPermissions: senders.pendingPermissions }
        : {})}
      {...(senders.resolvePermission !== undefined
        ? { resolvePermission: senders.resolvePermission }
        : {})}
    />,
  );
}

function runningSession(id: string, path = '/abs/one'): SessionState {
  return {
    id,
    projectPath: path,
    role: 'shipwright',
    status: 'running',
    sdkSessionId: null,
  };
}

/** Stamp a body with sessionId/seq/ts, mirroring the wire shape. */
function stamp(seq: number, sessionId = 'sess-1'): { sessionId: string; seq: number; ts: number } {
  return { sessionId, seq, ts: 1700000000000 + seq };
}

function fixtureEvents(): readonly TranscriptEvent[] {
  return [
    { kind: 'init', ...stamp(0) },
    { kind: 'assistant-text', text: 'Reading the plan now', ...stamp(1) },
    { kind: 'tool-use', toolName: 'Bash', toolInput: '{"command":"ls"}', toolUseId: 'tu-1', ...stamp(2) },
    { kind: 'tool-result', toolUseId: 'tu-1', content: 'src and tests listed', isError: false, ...stamp(3) },
    {
      kind: 'result',
      durationMs: 1234,
      numTurns: 3,
      totalCostUsd: 0.0521,
      inputTokens: 100,
      outputTokens: 42,
      isError: false,
      ...stamp(4),
    },
  ];
}

describe('TeamRoom', () => {
  it('shows the empty state when there is no running session', () => {
    renderRoom({}, {});

    expect(screen.getByTestId('team-room-empty')).toBeInTheDocument();
  });

  it('shows the empty state when all sessions have ended', () => {
    const ended: SessionState = { ...runningSession('sess-1'), status: 'ended' };
    renderRoom({ '/abs/one': [ended] }, {});

    expect(screen.getByTestId('team-room-empty')).toBeInTheDocument();
  });

  it('renders every transcript row kind for the live session', () => {
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, { 'sess-1': fixtureEvents() });

    expect(screen.queryByTestId('team-room-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('team-room-session-sess-1')).toBeInTheDocument();

    expect(screen.getByTestId('transcript-row-0')).toHaveAttribute('data-kind', 'init');
    expect(screen.getByTestId('transcript-row-1')).toHaveAttribute('data-kind', 'assistant-text');
    expect(screen.getByTestId('transcript-row-2')).toHaveAttribute('data-kind', 'tool-use');
    expect(screen.getByTestId('transcript-row-3')).toHaveAttribute('data-kind', 'tool-result');
    expect(screen.getByTestId('transcript-row-4')).toHaveAttribute('data-kind', 'result');

    // Row content: assistant text, tool name + input, tool-result content.
    expect(screen.getByText('Reading the plan now')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('{"command":"ls"}')).toBeInTheDocument();
    expect(screen.getByText('src and tests listed')).toBeInTheDocument();
  });

  it('renders the result metrics row with tokens, duration, turns, and cost', () => {
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, { 'sess-1': fixtureEvents() });

    const resultRow = screen.getByTestId('transcript-row-4');
    expect(resultRow).toHaveAttribute('data-error', 'false');
    expect(resultRow).toHaveTextContent('in 100');
    expect(resultRow).toHaveTextContent('out 42');
    expect(resultRow).toHaveTextContent('1234ms');
    expect(resultRow).toHaveTextContent('3 turns');
    expect(resultRow).toHaveTextContent('$0.0521');
  });

  it('marks an error tool-result row with error styling attributes', () => {
    const events: readonly TranscriptEvent[] = [
      { kind: 'tool-result', toolUseId: null, content: 'boom', isError: true, ...stamp(0) },
    ];
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, { 'sess-1': events });

    const row = screen.getByTestId('transcript-row-0');
    expect(row).toHaveAttribute('data-kind', 'tool-result');
    expect(row).toHaveAttribute('data-error', 'true');
    expect(row).toHaveTextContent('boom');
  });

  it('shows the most recent running session when several exist', () => {
    renderRoom(
      { '/abs/one': [runningSession('sess-1'), runningSession('sess-2')] },
      { 'sess-2': [{ kind: 'assistant-text', text: 'from sess-2', ...stamp(0, 'sess-2') }] },
    );

    expect(screen.getByTestId('team-room-session-sess-2')).toBeInTheDocument();
    expect(screen.getByText('from sess-2')).toBeInTheDocument();
  });

  it('truncates long tool input in the tool-use row', () => {
    const longInput = 'x'.repeat(400);
    const events: readonly TranscriptEvent[] = [
      { kind: 'tool-use', toolName: 'Write', toolInput: longInput, toolUseId: null, ...stamp(0) },
    ];
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, { 'sess-1': events });

    const row = screen.getByTestId('transcript-row-0');
    expect(row.textContent).toContain('…');
    expect(row.textContent).not.toContain(longInput);
  });

  it('renders a user-text row (the human steer echo) with its own kind', () => {
    const events: readonly TranscriptEvent[] = [
      { kind: 'user-text', text: 'focus on the auth module', ...stamp(0) },
    ];
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, { 'sess-1': events });

    const row = screen.getByTestId('transcript-row-0');
    expect(row).toHaveAttribute('data-kind', 'user-text');
    expect(row).toHaveTextContent('focus on the auth module');
  });

  it('typing a message and clicking Send steers the live session and clears the field', () => {
    const sendSessionInput = vi.fn();
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, {}, { sendSessionInput });

    const input = screen.getByTestId('team-room-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'refactor the parser' } });
    fireEvent.click(screen.getByTestId('team-room-send'));

    expect(sendSessionInput).toHaveBeenCalledWith('sess-1', 'refactor the parser');
    expect(input.value).toBe('');
  });

  it('disables Send for an empty (or whitespace-only) draft', () => {
    const sendSessionInput = vi.fn();
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, {}, { sendSessionInput });

    const send = screen.getByTestId('team-room-send') as HTMLButtonElement;
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByTestId('team-room-input'), { target: { value: '   ' } });
    expect(send).toBeDisabled();

    fireEvent.click(send);
    expect(sendSessionInput).not.toHaveBeenCalled();
  });

  it('clicking Interrupt interrupts the live session', () => {
    const interruptSession = vi.fn();
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, {}, { interruptSession });

    fireEvent.click(screen.getByTestId('team-room-interrupt'));

    expect(interruptSession).toHaveBeenCalledWith('sess-1');
  });

  it('renders a pending permission card for the live session with its title', () => {
    const request: PermissionRequest = {
      path: '/abs/one',
      sessionId: 'sess-1',
      requestId: 'req1',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      title: 'Run shell command',
      input: '{"command":"ls"}',
    };
    renderRoom(
      { '/abs/one': [runningSession('sess-1')] },
      {},
      { pendingPermissions: { 'sess-1': [request] } },
    );

    const card = screen.getByTestId('permission-card-req1');
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('Run shell command');
  });

  it('clicking Allow on a permission card resolves it with "allow"', () => {
    const resolvePermission = vi.fn();
    const request: PermissionRequest = {
      path: '/abs/one',
      sessionId: 'sess-1',
      requestId: 'req1',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      title: 'Run shell command',
      input: '{"command":"ls"}',
    };
    renderRoom(
      { '/abs/one': [runningSession('sess-1')] },
      {},
      { pendingPermissions: { 'sess-1': [request] }, resolvePermission },
    );

    fireEvent.click(screen.getByTestId('permission-allow-req1'));

    expect(resolvePermission).toHaveBeenCalledWith('sess-1', 'req1', 'allow');
  });

  it('clicking Deny on a permission card resolves it with "deny"', () => {
    const resolvePermission = vi.fn();
    const request: PermissionRequest = {
      path: '/abs/one',
      sessionId: 'sess-1',
      requestId: 'req1',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      title: 'Run shell command',
      input: '{"command":"ls"}',
    };
    renderRoom(
      { '/abs/one': [runningSession('sess-1')] },
      {},
      { pendingPermissions: { 'sess-1': [request] }, resolvePermission },
    );

    fireEvent.click(screen.getByTestId('permission-deny-req1'));

    expect(resolvePermission).toHaveBeenCalledWith('sess-1', 'req1', 'deny');
  });

  it('renders no permission card when pendingPermissions is empty', () => {
    renderRoom({ '/abs/one': [runningSession('sess-1')] }, {}, { pendingPermissions: {} });

    expect(screen.queryByTestId(/^permission-card-/)).not.toBeInTheDocument();
  });
});
