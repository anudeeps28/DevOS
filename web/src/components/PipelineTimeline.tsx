import type { PipelineTimelineModel, TimelineStage } from '@/lib/pipeline-timeline';
import { cn } from '@/lib/utils';

/** One stage in the pipeline timeline, highlighted when it is the current stage. */
function StageItem({ stage }: { stage: TimelineStage }): JSX.Element {
  return (
    <li
      data-testid="pipeline-stage"
      data-phase={stage.phase}
      data-current={stage.current ? 'true' : 'false'}
      className={cn(
        'flex flex-col gap-1 rounded-md border border-border bg-card p-2.5',
        stage.current && 'border-primary bg-primary/10',
      )}
    >
      <span
        className={cn(
          'rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground',
          stage.current && 'border-primary text-primary',
        )}
      >
        {stage.persona}
      </span>
      <span className="text-xs text-muted-foreground">{stage.phase}</span>
    </li>
  );
}

/**
 * Presentational pipeline-timeline view: an ordered list of stages with the
 * current stage highlighted, plus a rework-loop badge. All state is derived
 * upstream by `derivePipelineTimeline`; this component only renders.
 */
export function PipelineTimeline({ model }: { model: PipelineTimelineModel }): JSX.Element {
  return (
    <div className={cn('flex w-full max-w-md flex-col gap-3')}>
      <span
        data-testid="pipeline-loop"
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {`loop ${model.loopNumber} of ${model.loopCap}`}
      </span>
      {model.stages.length === 0 ? (
        <p
          data-testid="pipeline-empty"
          className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
        >
          No pipeline stages.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {model.stages.map((stage) => (
            <StageItem key={stage.phase} stage={stage} />
          ))}
        </ol>
      )}
    </div>
  );
}
