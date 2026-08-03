import type { BoardColumn, BoardModel, WorkItemCard } from '@/lib/board-state';
import { cn } from '@/lib/utils';

/** One card within a board column: title + persona/phase label, clickable to open Detail. */
function Card({
  card,
  column,
  onOpenItem,
}: {
  card: WorkItemCard;
  column: BoardColumn;
  onOpenItem: (workItemId: string, path: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid="board-card"
      data-workitem={card.workItemId}
      data-phase={card.phase ?? ''}
      data-column={column.id}
      onClick={() => onOpenItem(card.workItemId, card.projectPath)}
      className="flex w-full flex-col gap-1 rounded-md border border-border bg-background p-2 text-left hover:bg-muted"
    >
      <span className="truncate text-xs font-medium text-foreground">{card.title}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {card.persona ?? card.phase ?? '—'}
      </span>
    </button>
  );
}

/** One board column: header with label + count, then its ordered cards (or an empty state). */
function Column({
  column,
  onOpenItem,
}: {
  column: BoardColumn;
  onOpenItem: (workItemId: string, path: string) => void;
}): JSX.Element {
  return (
    <div
      data-testid="board-column"
      data-column={column.id}
      className="flex w-48 shrink-0 flex-col gap-2 rounded-lg border border-border bg-card p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
          {column.label}
        </span>
        <span className="text-[10px] text-muted-foreground">{column.cards.length}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {column.cards.length === 0 ? (
          <span className="text-[10px] italic text-muted-foreground/60">no items</span>
        ) : (
          column.cards.map((card) => (
            <Card
              key={`${card.workItemId}:${card.projectPath}`}
              card={card}
              column={column}
              onOpenItem={onOpenItem}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Presentational kanban board: the seven fixed columns from `deriveBoard`,
 * each holding its ordered work-item cards. All state is derived upstream;
 * this component only renders and reports clicks via `onOpenItem`.
 */
export function Board({
  model,
  onOpenItem,
}: {
  model: BoardModel;
  onOpenItem: (workItemId: string, path: string) => void;
}): JSX.Element {
  return (
    <div className={cn('flex w-full max-w-4xl flex-row gap-3 overflow-x-auto')}>
      {model.columns.map((column) => (
        <Column key={column.id} column={column} onOpenItem={onOpenItem} />
      ))}
    </div>
  );
}
