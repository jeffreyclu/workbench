// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffBlockList, DiffSummaryStrip } from './diff-review.js';
import { LOW_RISK_THRESHOLD, isLowRiskAssessment } from './diff-review-logic.js';

const changedBlock = {
  key: 'block-1',
  lines: [
    { key: 'old', kind: 'deletion' as const, oldLine: 1, newLine: null, text: '-before' },
    { key: 'new', kind: 'addition' as const, oldLine: null, newLine: 1, text: '+after' },
  ],
};

afterEach(cleanup);

describe('diff review presentation', () => {
  it('treats only numeric scores below 30 as low risk', () => {
    expect(LOW_RISK_THRESHOLD).toBe(30);
    expect(isLowRiskAssessment({ risk: 29, reasoning: 'Safe local change.' })).toBe(true);
    expect(isLowRiskAssessment({ risk: 30, reasoning: 'At the threshold.' })).toBe(false);
    expect(isLowRiskAssessment(null)).toBe(false);
    expect(isLowRiskAssessment({ risk: null, reasoning: 'Assessment unavailable.' })).toBe(false);
  });

  it('collapses a low-risk changed block and expands it through its accessible disclosure', () => {
    render(<DiffBlockList blocks={[changedBlock]} lineHtml={new Map()} filePath="src/example.ts" assessments={{ 'block-1': { risk: 12, reasoning: 'Local rename only.' } }} />);

    const disclosure = screen.getByLabelText('Show low-risk change, risk 12 out of 100');
    expect(disclosure.tagName).toBe('SUMMARY');
    expect(disclosure.parentElement).not.toHaveAttribute('open');
    fireEvent.click(disclosure);
    expect(disclosure.parentElement).toHaveAttribute('open');
    expect(screen.getByLabelText('AI risk assessment: 12 out of 100')).toBeInTheDocument();
    expect(document.querySelector('.diff-line.addition')).toHaveTextContent('+');
  });

  it('keeps pending and unavailable assessments expanded for review', () => {
    const { rerender } = render(<DiffBlockList blocks={[changedBlock]} lineHtml={new Map()} filePath="src/example.ts" assessments={{ 'block-1': null }} />);
    expect(screen.getByLabelText('AI assessment in progress')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Show low-risk change/)).not.toBeInTheDocument();

    rerender(<DiffBlockList blocks={[changedBlock]} lineHtml={new Map()} filePath="src/example.ts" assessments={{ 'block-1': { risk: null, reasoning: 'Assessment unavailable.' } }} />);
    expect(screen.getByRole('button', { name: 'AI assessment unavailable' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Show low-risk change/)).not.toBeInTheDocument();
  });

  it('renders changed-file and line totals in one concise summary strip', () => {
    render(<DiffSummaryStrip changedFiles={3} additions={21} deletions={8} flaggedCount={0} />);
    expect(screen.getByLabelText('3 changed files, 21 additions, 8 deletions')).toHaveTextContent('3 files+21−8');
    expect(screen.queryByRole('button', { name: 'Next flagged block' })).not.toBeInTheDocument();
  });

  it('shows the flagged-block count and a jump action once blocks are flagged', () => {
    const onJumpToNextFlagged = vi.fn();
    render(<DiffSummaryStrip changedFiles={3} additions={21} deletions={8} flaggedCount={2} onJumpToNextFlagged={onJumpToNextFlagged} />);
    expect(screen.getByLabelText('3 changed files, 21 additions, 8 deletions, 2 blocks flagged high-risk')).toHaveTextContent('2 blocks flagged high-risk');
    fireEvent.click(screen.getByRole('button', { name: 'Next flagged block' }));
    expect(onJumpToNextFlagged).toHaveBeenCalledTimes(1);
  });
});
