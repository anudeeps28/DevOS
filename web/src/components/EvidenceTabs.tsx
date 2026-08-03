import { useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Structural shape of the evidence data this component renders. Defined locally — no server
 * types imported. Uses readonly arrays to match the validated (readonly) EvidenceData the WS
 * client hands up through useProjects, so callers pass it through without an unsound cast.
 */
export interface EvidenceData {
  readonly filesChanged: readonly { readonly path: string; readonly status: string }[];
  readonly testResults: { readonly summary: string };
  readonly prSummary: string;
  readonly artifacts: readonly { readonly name: string; readonly state: 'Draft' | 'Final' }[];
}

type EvidenceTab = 'files' | 'tests' | 'pr' | 'audit';

const TABS: { id: EvidenceTab; label: string }[] = [
  { id: 'files', label: 'Files changed' },
  { id: 'tests', label: 'Test results' },
  { id: 'pr', label: 'PR summary' },
  { id: 'audit', label: 'Audit' },
];

/**
 * Presentational evidence-tabs view: tabbed panels for files changed, test
 * results, PR summary, and artifacts. All data is derived upstream and
 * passed in as a prop; this component only renders and tracks local tab
 * selection state.
 */
export function EvidenceTabs({ evidence }: { evidence: EvidenceData | undefined }): JSX.Element {
  const [activeTab, setActiveTab] = useState<EvidenceTab>('files');

  if (evidence === undefined) {
    return (
      <div
        data-testid="evidence-loading"
        className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground"
      >
        Loading evidence...
      </div>
    );
  }

  return (
    <div className={cn('flex w-full max-w-md flex-col gap-3')}>
      <div className="flex gap-1 border-b border-border" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            data-testid={`evidence-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'rounded-t-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground',
              activeTab === tab.id && 'border-b-2 border-primary text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === 'files' && (
        <div data-testid="evidence-panel-files" className="flex flex-col gap-2">
          {evidence.filesChanged.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files changed yet</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {evidence.filesChanged.map((file) => (
                <li
                  key={file.path}
                  className="flex items-center justify-between rounded-md border border-border bg-card px-2 py-1 text-xs"
                >
                  <span className="text-foreground">{file.path}</span>
                  <span className="text-muted-foreground">{file.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {activeTab === 'tests' && (
        <div data-testid="evidence-panel-tests" className="text-sm text-muted-foreground">
          {evidence.testResults.summary === '' ? 'No test results yet' : evidence.testResults.summary}
        </div>
      )}
      {activeTab === 'pr' && (
        <div data-testid="evidence-panel-pr" className="text-sm text-muted-foreground">
          {evidence.prSummary === '' ? 'No PR summary yet' : evidence.prSummary}
        </div>
      )}
      {activeTab === 'audit' && (
        <div data-testid="evidence-panel-audit" className="flex flex-col gap-2">
          {evidence.artifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No artifacts yet</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {evidence.artifacts.map((artifact) => (
                <li
                  key={artifact.name}
                  data-testid="evidence-artifact"
                  className="flex items-center justify-between rounded-md border border-border bg-card px-2 py-1 text-xs"
                >
                  <span className="text-foreground">{artifact.name}</span>
                  <span
                    data-testid="evidence-badge"
                    data-state={artifact.state}
                    className={cn(
                      'rounded-full border border-border px-2 py-0.5 text-xs font-medium',
                      artifact.state === 'Final' ? 'border-primary text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {artifact.state}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
