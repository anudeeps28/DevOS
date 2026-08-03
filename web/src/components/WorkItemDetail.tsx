import { useEffect } from 'react';

import type { PipelineTimelineModel } from '@/lib/pipeline-timeline';
import { PipelineTimeline } from '@/components/PipelineTimeline';
import { EvidenceTabs } from '@/components/EvidenceTabs';
import { cn } from '@/lib/utils';

/**
 * Structural shape of the evidence snapshot this component accepts — mirrors
 * EvidenceTabsData but with readonly arrays, matching the validated
 * (readonly) EvidenceData the WS client hands up through useProjects.
 */
export interface EvidenceData {
  readonly filesChanged: readonly { path: string; status: string }[];
  readonly testResults: { summary: string };
  readonly prSummary: string;
  readonly artifacts: readonly { name: string; state: 'Draft' | 'Final' }[];
}

/**
 * Presentational work-item detail screen: a header with a back control, the
 * work item's pipeline timeline, and its evidence tabs. No data fetching —
 * the model and evidence are derived/fetched upstream and passed in as props;
 * this component requests a fresh evidence snapshot on open/change.
 */
export function WorkItemDetail({
  workItemId,
  model,
  evidence,
  onBack,
  onRequestEvidence,
}: {
  workItemId: string;
  model: PipelineTimelineModel;
  evidence?: EvidenceData | undefined;
  onBack: () => void;
  onRequestEvidence: () => void;
}): JSX.Element {
  useEffect(() => {
    onRequestEvidence();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItemId]);

  return (
    <div
      data-testid="work-item-detail"
      data-workitem={workItemId}
      className={cn('flex w-full max-w-md flex-col gap-3')}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="detail-back"
          onClick={onBack}
          className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          Back
        </button>
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {workItemId}
        </span>
      </div>
      <PipelineTimeline model={model} />
      <EvidenceTabs evidence={evidence} />
    </div>
  );
}
