import { cn } from '@/lib/utils';

/** The three top-level tabs the app shell switches between. */
export type TabId = 'projects' | 'skills' | 'fleet' | 'inbox';

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'skills', label: 'Skills' },
  { id: 'fleet', label: 'Fleet' },
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
}: {
  active: TabId;
  onSelect: (tab: TabId) => void;
}): JSX.Element {
  return (
    <nav
      data-testid="left-rail"
      className="flex flex-col gap-1 border-r border-border p-2"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-testid={`tab-${tab.id}`}
          aria-current={active === tab.id ? 'page' : undefined}
          onClick={() => onSelect(tab.id)}
          className={cn(
            'rounded-md px-3 py-1.5 text-left text-sm font-medium',
            active === tab.id
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
