// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
