import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkItemDetail } from '@/components/WorkItemDetail';
import type { PipelineTimelineModel } from '@/lib/pipeline-timeline';

function model(): PipelineTimelineModel {
  return {
    stages: [{ phase: 'coding', persona: 'Shipwright', current: true }],
    currentPhase: 'coding',
    currentPersona: 'Shipwright',
    loopNumber: 0,
    loopCap: 3,
  };
}

describe('WorkItemDetail', () => {
  it('renders the work item id and hosts the pipeline timeline', () => {
    render(
      <WorkItemDetail workItemId="wi-1" model={model()} onBack={vi.fn()} onRequestEvidence={vi.fn()} />,
    );

    const detail = screen.getByTestId('work-item-detail');
    expect(detail).toHaveAttribute('data-workitem', 'wi-1');
    expect(detail).toHaveTextContent('wi-1');
    expect(screen.getByTestId('pipeline-stage')).toBeInTheDocument();
  });

  it('fires onBack when the back button is clicked', () => {
    const onBack = vi.fn();

    render(
      <WorkItemDetail workItemId="wi-1" model={model()} onBack={onBack} onRequestEvidence={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('detail-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
