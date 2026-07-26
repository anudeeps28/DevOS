import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TeamRoom } from '@/components/TeamRoom';
import type { SessionState, TranscriptEvent } from '@/lib/ws-client';

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
    render(<TeamRoom sessions={{}} transcripts={{}} />);

    expect(screen.getByTestId('team-room-empty')).toBeInTheDocument();
  });

  it('shows the empty state when all sessions have ended', () => {
    const ended: SessionState = { ...runningSession('sess-1'), status: 'ended' };
    render(<TeamRoom sessions={{ '/abs/one': [ended] }} transcripts={{}} />);

    expect(screen.getByTestId('team-room-empty')).toBeInTheDocument();
  });

  it('renders every transcript row kind for the live session', () => {
    render(
      <TeamRoom
        sessions={{ '/abs/one': [runningSession('sess-1')] }}
        transcripts={{ 'sess-1': fixtureEvents() }}
      />,
    );

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
    render(
      <TeamRoom
        sessions={{ '/abs/one': [runningSession('sess-1')] }}
        transcripts={{ 'sess-1': fixtureEvents() }}
      />,
    );

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
    render(
      <TeamRoom
        sessions={{ '/abs/one': [runningSession('sess-1')] }}
        transcripts={{ 'sess-1': events }}
      />,
    );

    const row = screen.getByTestId('transcript-row-0');
    expect(row).toHaveAttribute('data-kind', 'tool-result');
    expect(row).toHaveAttribute('data-error', 'true');
    expect(row).toHaveTextContent('boom');
  });

  it('shows the most recent running session when several exist', () => {
    render(
      <TeamRoom
        sessions={{
          '/abs/one': [runningSession('sess-1'), runningSession('sess-2')],
        }}
        transcripts={{
          'sess-2': [{ kind: 'assistant-text', text: 'from sess-2', ...stamp(0, 'sess-2') }],
        }}
      />,
    );

    expect(screen.getByTestId('team-room-session-sess-2')).toBeInTheDocument();
    expect(screen.getByText('from sess-2')).toBeInTheDocument();
  });

  it('truncates long tool input in the tool-use row', () => {
    const longInput = 'x'.repeat(400);
    const events: readonly TranscriptEvent[] = [
      { kind: 'tool-use', toolName: 'Write', toolInput: longInput, toolUseId: null, ...stamp(0) },
    ];
    render(
      <TeamRoom
        sessions={{ '/abs/one': [runningSession('sess-1')] }}
        transcripts={{ 'sess-1': events }}
      />,
    );

    const row = screen.getByTestId('transcript-row-0');
    expect(row.textContent).toContain('…');
    expect(row.textContent).not.toContain(longInput);
  });
});
