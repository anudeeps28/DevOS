import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HookBusIndicator } from '@/components/HookBusIndicator';

describe('HookBusIndicator', () => {
  it('renders the not-connected badge when connected is false', () => {
    render(<HookBusIndicator connected={false} />);

    const badge = screen.getByTestId('hook-bus-status');
    expect(badge).toHaveAttribute('data-connected', 'false');
    expect(badge).toHaveTextContent('Hook bus not connected');
  });

  it('renders nothing when connected is true', () => {
    render(<HookBusIndicator connected={true} />);

    expect(screen.queryByTestId('hook-bus-status')).not.toBeInTheDocument();
  });
});
