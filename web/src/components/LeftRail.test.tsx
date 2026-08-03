import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LeftRail } from '@/components/LeftRail';

describe('LeftRail', () => {
  it('marks the active tab with aria-current="page"', () => {
    render(<LeftRail active="fleet" onSelect={() => {}} />);

    expect(screen.getByTestId('tab-fleet')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('tab-projects')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('tab-skills')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('tab-inbox')).not.toHaveAttribute('aria-current');
  });

  it('calls onSelect with the clicked tab id', () => {
    const onSelect = vi.fn();
    render(<LeftRail active="projects" onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('tab-skills'));
    expect(onSelect).toHaveBeenCalledWith('skills');

    fireEvent.click(screen.getByTestId('tab-fleet'));
    expect(onSelect).toHaveBeenCalledWith('fleet');

    fireEvent.click(screen.getByTestId('tab-inbox'));
    expect(onSelect).toHaveBeenCalledWith('inbox');
  });

  it('renders the inbox badge count when positive', () => {
    render(<LeftRail active="inbox" onSelect={() => {}} badges={{ inbox: 3 }} />);

    expect(screen.getByTestId('tab-badge-inbox')).toHaveTextContent('3');
  });

  it('renders no inbox badge when the count is zero or absent', () => {
    const { rerender } = render(
      <LeftRail active="inbox" onSelect={() => {}} badges={{ inbox: 0 }} />,
    );
    expect(screen.queryByTestId('tab-badge-inbox')).not.toBeInTheDocument();

    rerender(<LeftRail active="inbox" onSelect={() => {}} />);
    expect(screen.queryByTestId('tab-badge-inbox')).not.toBeInTheDocument();
  });
});
