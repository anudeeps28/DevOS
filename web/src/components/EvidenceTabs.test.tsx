import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EvidenceTabs, type EvidenceData } from '@/components/EvidenceTabs';

function evidence(overrides: Partial<EvidenceData> = {}): EvidenceData {
  return {
    filesChanged: [
      { path: 'src/foo.ts', status: 'modified' },
      { path: 'src/bar.ts', status: 'added' },
    ],
    testResults: { summary: '12 passed, 0 failed' },
    prSummary: 'Adds the foo feature.',
    artifacts: [
      { name: 'design-doc', state: 'Draft' },
      { name: 'release-notes', state: 'Final' },
    ],
    ...overrides,
  };
}

describe('EvidenceTabs', () => {
  it('renders four tab controls', () => {
    render(<EvidenceTabs evidence={evidence()} />);

    expect(screen.getByTestId('evidence-tab-files')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-tab-tests')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-tab-pr')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-tab-audit')).toBeInTheDocument();
  });

  it('defaults to the files changed panel and lists path+status rows', () => {
    render(<EvidenceTabs evidence={evidence()} />);

    const panel = screen.getByTestId('evidence-panel-files');
    expect(panel).toHaveTextContent('src/foo.ts');
    expect(panel).toHaveTextContent('modified');
    expect(panel).toHaveTextContent('src/bar.ts');
    expect(panel).toHaveTextContent('added');
  });

  it('clicking the tests tab shows the test results panel', () => {
    render(<EvidenceTabs evidence={evidence()} />);

    fireEvent.click(screen.getByTestId('evidence-tab-tests'));

    expect(screen.getByTestId('evidence-panel-tests')).toHaveTextContent('12 passed, 0 failed');
    expect(screen.queryByTestId('evidence-panel-files')).not.toBeInTheDocument();
  });

  it('clicking the pr tab shows the pr summary panel', () => {
    render(<EvidenceTabs evidence={evidence()} />);

    fireEvent.click(screen.getByTestId('evidence-tab-pr'));

    expect(screen.getByTestId('evidence-panel-pr')).toHaveTextContent('Adds the foo feature.');
  });

  it('clicking the audit tab shows the artifacts panel', () => {
    render(<EvidenceTabs evidence={evidence()} />);

    fireEvent.click(screen.getByTestId('evidence-tab-audit'));

    expect(screen.getByTestId('evidence-panel-audit')).toBeInTheDocument();
  });

  it('shows empty state when there are no files changed', () => {
    render(<EvidenceTabs evidence={evidence({ filesChanged: [] })} />);

    expect(screen.getByTestId('evidence-panel-files')).toHaveTextContent('No files changed yet');
  });

  it('shows empty state when test results summary is empty', () => {
    render(<EvidenceTabs evidence={evidence({ testResults: { summary: '' } })} />);

    fireEvent.click(screen.getByTestId('evidence-tab-tests'));

    expect(screen.getByTestId('evidence-panel-tests')).toHaveTextContent('No test results yet');
  });

  it('shows empty state when pr summary is empty', () => {
    render(<EvidenceTabs evidence={evidence({ prSummary: '' })} />);

    fireEvent.click(screen.getByTestId('evidence-tab-pr'));

    expect(screen.getByTestId('evidence-panel-pr')).toHaveTextContent('No PR summary yet');
  });

  it('shows empty state when there are no artifacts', () => {
    render(<EvidenceTabs evidence={evidence({ artifacts: [] })} />);

    fireEvent.click(screen.getByTestId('evidence-tab-audit'));

    expect(screen.getByTestId('evidence-panel-audit')).toHaveTextContent('No artifacts yet');
  });

  it('renders a Final badge for a Final artifact and a Draft badge for a Draft artifact', () => {
    render(<EvidenceTabs evidence={evidence()} />);

    fireEvent.click(screen.getByTestId('evidence-tab-audit'));

    const badges = screen.getAllByTestId('evidence-badge');
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveAttribute('data-state', 'Draft');
    expect(badges[1]).toHaveAttribute('data-state', 'Final');
  });

  it('renders the loading container and not the tabs when evidence is undefined', () => {
    render(<EvidenceTabs evidence={undefined} />);

    expect(screen.getByTestId('evidence-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('evidence-tab-files')).not.toBeInTheDocument();
  });
});
