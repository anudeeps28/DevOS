import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PipelineTimeline } from '@/components/PipelineTimeline';
import type { PipelineTimelineModel } from '@/lib/pipeline-timeline';

function model(overrides: Partial<PipelineTimelineModel> = {}): PipelineTimelineModel {
  return {
    stages: [
      { phase: 'planning', persona: 'Navigator', current: false },
      { phase: 'coding', persona: 'Shipwright', current: true },
      { phase: 'testing', persona: 'Lookout', current: false },
      { phase: 'reviewing', persona: 'Warden', current: false },
      { phase: 'shipping', persona: 'Harbormaster', current: false },
    ],
    currentPhase: 'coding',
    currentPersona: 'Shipwright',
    loopNumber: 2,
    loopCap: 3,
    ...overrides,
  };
}

describe('PipelineTimeline', () => {
  it('renders the 5 stages in order with only the coding stage current', () => {
    render(<PipelineTimeline model={model()} />);

    const stages = screen.getAllByTestId('pipeline-stage');
    expect(stages).toHaveLength(5);

    const personas = stages.map((stage) => stage.textContent);
    expect(personas[0]).toContain('Navigator');
    expect(personas[1]).toContain('Shipwright');
    expect(personas[2]).toContain('Lookout');
    expect(personas[3]).toContain('Warden');
    expect(personas[4]).toContain('Harbormaster');

    stages.forEach((stage, index) => {
      expect(stage).toHaveAttribute('data-current', index === 1 ? 'true' : 'false');
    });
    expect(stages[1]).toHaveAttribute('data-phase', 'coding');
  });

  it('renders the loop badge with the loop number and cap', () => {
    render(<PipelineTimeline model={model()} />);

    const loop = screen.getByTestId('pipeline-loop');
    expect(loop).toHaveTextContent('loop 2');
    expect(loop).toHaveTextContent('of 3');
  });

  it('renders the empty placeholder when there are no stages', () => {
    render(<PipelineTimeline model={model({ stages: [], currentPhase: null, currentPersona: null })} />);

    expect(screen.getByTestId('pipeline-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('pipeline-stage')).not.toBeInTheDocument();
  });
});
