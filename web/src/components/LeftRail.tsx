import { cn } from '@/lib/utils';

/** The three top-level tabs the app shell switches between. */
export type TabId = 'projects' | 'skills' | 'fleet' | 'board' | 'inbox';

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'skills', label: 'Skills' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'board', label: 'Board' },
  { id: 'inbox', label: 'Inbox' },
];

/**
 * Presentational left-rail tab switcher: three buttons, the active one marked
 * `aria-current="page"`. All state lives upstream — this component only
 * renders `active` and reports clicks via `onSelect`.
 */
export function LeftRail({
  active,
  onSelect,
  badges,
}: {
  active: TabId;
  onSelect: (tab: TabId) => void;
  badges?: Partial<Record<TabId, number>>;
}): JSX.Element {
  return (
    <nav
      data-testid="left-rail"
      className="flex flex-col gap-1 border-r border-border p-2"
    >
      {TABS.map((tab) => {
        const count = badges?.[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            data-testid={`tab-${tab.id}`}
            aria-current={active === tab.id ? 'page' : undefined}
            onClick={() => onSelect(tab.id)}
            className={cn(
              'flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm font-medium',
              active === tab.id
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span>{tab.label}</span>
            {count !== undefined && count > 0 && (
              <span
                data-testid={`tab-badge-${tab.id}`}
                className="rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground"
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
