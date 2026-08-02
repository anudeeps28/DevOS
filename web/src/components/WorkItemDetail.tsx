import type { PipelineTimelineModel } from '@/lib/pipeline-timeline';
import { PipelineTimeline } from '@/components/PipelineTimeline';
import { cn } from '@/lib/utils';

/**
 * Presentational work-item detail screen: a header with a back control and
 * the work item's pipeline timeline. No data fetching — the model is
 * derived upstream and passed in as a prop.
 */
export function WorkItemDetail({
  workItemId,
  model,
  onBack,
}: {
  workItemId: string;
  model: PipelineTimelineModel;
  onBack: () => void;
}): JSX.Element {
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
    </div>
  );
}
