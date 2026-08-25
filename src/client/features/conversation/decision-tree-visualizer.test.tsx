// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SharedMessage } from '../../../shared/contracts';
import { DecisionTreeVisualizer } from './decision-tree-visualizer';

const messages: SharedMessage[] = [{
  id: 'request', conversationId: 'conversation', author: 'jeffrey', body: 'Debug this', pinned: false,
  status: 'completed', error: '', createdAt: '2026-08-25T12:00:00.000Z', completedAt: null,
  attachments: [], model: null, accountProfile: null, executionProfile: null, inputTokens: null,
  cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null, estimatedCostUsd: null,
  costSource: null, fallbackFrom: null, fallbackReason: null, dispatchTarget: 'codex', dispatchGroupId: null,
  attempt: 0, maxAttempts: 3, nextAttemptAt: null, queuePriority: 0, retrievedMemoryCount: null,
}, {
  id: 'stream', conversationId: 'conversation', author: 'codex', body: '', pinned: false,
  status: 'running', error: '', createdAt: '2026-08-25T12:00:01.000Z', completedAt: null,
  attachments: [], model: 'gpt-5.6', accountProfile: 'default', executionProfile: 'standard', inputTokens: null,
  cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null, estimatedCostUsd: null,
  costSource: null, fallbackFrom: null, fallbackReason: null, dispatchTarget: 'none', dispatchGroupId: 'request',
  attempt: 0, maxAttempts: 3, nextAttemptAt: null, queuePriority: 0, retrievedMemoryCount: 2,
}];

describe('DecisionTreeVisualizer', () => {
  afterEach(cleanup);

  it('renders each dispatch and its live stream, then closes accessibly', () => {
    const onClose = vi.fn();
    render(<DecisionTreeVisualizer messages={messages} events={[
      { id: 'decision', messageId: 'stream', runId: null, kind: 'decision', detail: 'Check the existing tests before changing behavior.', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'tool', messageId: 'stream', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:02.000Z' },
    ]} isLoadingEvents={false} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Decisions and tools' })).toHaveTextContent('Requested Codex');
    expect(screen.getByRole('dialog')).toHaveTextContent('gpt-5.6 · standard · default · 2 memory matches');
    expect(screen.getByRole('dialog')).toHaveTextContent('Ran the test suite.');
    expect(screen.getByRole('dialog')).toHaveTextContent('Why: Check the existing tests before changing behavior.');
    fireEvent.click(screen.getByRole('button', { name: 'Close decision tree' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('updates the open debugger as live decisions and tool calls arrive', () => {
    const onClose = vi.fn();
    const { rerender } = render(<DecisionTreeVisualizer messages={messages} events={[]} isLoadingEvents onClose={onClose} />);

    expect(screen.getByText('Loading agent events…')).toBeInTheDocument();
    expect(screen.queryByText('Ran the test suite.')).not.toBeInTheDocument();

    rerender(<DecisionTreeVisualizer messages={messages} events={[{
      id: 'decision', messageId: 'stream', runId: null, kind: 'decision',
      detail: 'Confirm the new behavior before testing it.', createdAt: '2026-08-25T12:00:01.000Z',
    }]} isLoadingEvents={false} onClose={onClose} />);

    expect(screen.queryByText('Loading agent events…')).not.toBeInTheDocument();
    expect(screen.getByText('Confirm the new behavior before testing it.')).toBeInTheDocument();

    rerender(<DecisionTreeVisualizer messages={messages} events={[
      { id: 'decision', messageId: 'stream', runId: null, kind: 'decision', detail: 'Confirm the new behavior before testing it.', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'tool', messageId: 'stream', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:02.000Z' },
    ]} isLoadingEvents={false} onClose={onClose} />);

    expect(screen.getByText('Ran the test suite.')).toBeInTheDocument();
    expect(screen.getByText('Why: Confirm the new behavior before testing it.')).toBeInTheDocument();
  });

  it('does not invent a missing decision summary for calls without one', () => {
    const onClose = vi.fn();
    render(<DecisionTreeVisualizer messages={messages} events={[{
      id: 'tool', messageId: 'stream', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:02.000Z',
    }]} isLoadingEvents={false} onClose={onClose} />);

    expect(screen.getByText('Ran the test suite.')).toBeInTheDocument();
    expect(screen.queryByText(/No decision summary was recorded before this call/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Why:/)).not.toBeInTheDocument();
  });
});
