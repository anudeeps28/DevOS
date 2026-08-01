import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CostToday } from '@/components/CostToday';
import type { CostUsage } from '@/lib/ws-client';

describe('CostToday', () => {
  it('renders "—" when costToday is null', () => {
    render(<CostToday costToday={null} />);

    expect(screen.getByTestId('cost-today')).toHaveTextContent('—');
  });

  it('renders the formatted USD value when costToday is present', () => {
    const usage: CostUsage = {
      costTodayUsd: 12.3,
      inputTokensToday: 1000,
      outputTokensToday: 500,
      sinceEpochMs: 1700000000000,
    };

    render(<CostToday costToday={usage} />);

    expect(screen.getByTestId('cost-today')).toHaveTextContent('$12.30');
  });

  it('labels the figure "Usage today"', () => {
    render(<CostToday costToday={null} />);

    expect(screen.getByText('Usage today')).toBeInTheDocument();
  });
});
