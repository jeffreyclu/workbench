// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);
import { RetrievedMemoryDialog } from './retrieved-memory-dialog';

describe('RetrievedMemoryDialog', () => {
  it('shows the source-backed graph path for each retrieved memory', () => {
    render(<RetrievedMemoryDialog
      detail={{
        query: 'Staff promotion evidence',
        items: [{
          source: 'run_output',
          title: 'Connector rollout',
          body: 'Shipped the rollout safely.',
          createdAt: '2026-09-09T12:00:00.000Z',
          retrievalPath: ['Matched request', 'Same project', 'Task evidence'],
        }],
      }}
      loading={false}
      onClose={vi.fn()}
    />);

    expect(screen.getByText('Why: Matched request → Same project → Task evidence')).toBeInTheDocument();
    expect(screen.getByText('Shipped the rollout safely.')).toBeInTheDocument();
  });
});

describe('RetrievedMemoryDialog sections', () => {
  const item = (source: string, title: string, extra = {}) => ({ source, title, body: `${title} body`, createdAt: '2026-09-09T12:00:00.000Z', ...extra });

  it('lists retrieved items with citations and folds short-term conversations under their own label', () => {
    render(<RetrievedMemoryDialog
      detail={{
        query: 'password grant',
        items: [item('memory_entry', 'Lesson', { citation: '[lessons.md#4]' }), item('run_output', 'Run')],
        shortTermItems: [item('active_conversation', 'Pluto'), item('active_conversation', 'Golden dataset'), item('active_conversation', 'Modal')],
      }}
      loading={false}
      onClose={vi.fn()}
    />);

    expect(screen.getByText('Retrieved memories (2)')).toBeInTheDocument();
    expect(screen.getByText('memory_entry [lessons.md#4]')).toBeInTheDocument();
    const summary = screen.getByText('Open conversations (always included, not retrieved) (3)');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('password grant')).toBeInTheDocument();
  });

  it('treats active_conversation items in the old merged shape as short-term', () => {
    render(<RetrievedMemoryDialog
      detail={{ query: 'q', items: [item('run_output', 'Run'), item('active_conversation', 'Pluto')] }}
      loading={false}
      onClose={vi.fn()}
    />);

    expect(screen.getByText('Retrieved memories (1)')).toBeInTheDocument();
    expect(screen.getByText('Open conversations (always included, not retrieved) (1)')).toBeInTheDocument();
  });
});
