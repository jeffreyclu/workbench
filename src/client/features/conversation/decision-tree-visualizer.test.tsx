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

  it('renders one concise row for a recorded decision and tool call, then closes accessibly', () => {
    const onClose = vi.fn();
    render(<DecisionTreeVisualizer messages={messages} events={[
      { id: 'decision', messageId: 'stream', runId: null, kind: 'decision', detail: 'Check the existing tests before changing behavior.', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'tool', messageId: 'stream', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:02.000Z' },
    ]} isLoadingEvents={false} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Decisions and tools' })).toHaveTextContent('Why: Check the existing tests before changing behavior.');
    expect(screen.getByRole('dialog')).toHaveTextContent('Decision: Ran the test suite.');
    expect(screen.getByLabelText('Details: command_execution: npm test')).toHaveAttribute('title', 'command_execution: npm test');
    expect(screen.queryByText('Recorded the approach.')).not.toBeInTheDocument();
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
    expect(screen.queryByText('Confirm the new behavior before testing it.')).not.toBeInTheDocument();

    rerender(<DecisionTreeVisualizer messages={messages} events={[
      { id: 'decision', messageId: 'stream', runId: null, kind: 'decision', detail: 'Confirm the new behavior before testing it.', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'tool', messageId: 'stream', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:02.000Z' },
    ]} isLoadingEvents={false} onClose={onClose} />);

    expect(screen.getByText('Ran the test suite.')).toBeInTheDocument();
    expect(screen.getByText('Confirm the new behavior before testing it.')).toBeInTheDocument();
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

  it('uses the same row for Claude events', () => {
    render(<DecisionTreeVisualizer messages={[...messages.slice(0, 1), { ...messages[1], id: 'claude-stream', author: 'claude' }]} events={[
      { id: 'claude-decision', messageId: 'claude-stream', runId: null, kind: 'decision', detail: 'Inspect the route before editing it.', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'claude-read', messageId: 'claude-stream', runId: null, kind: 'file_read', detail: 'src/routes.ts', createdAt: '2026-08-25T12:00:02.000Z' },
    ]} isLoadingEvents={false} onClose={vi.fn()} />);

    expect(screen.getByText('Inspect the route before editing it.')).toBeInTheDocument();
    expect(screen.getByText('Read src/routes.ts.')).toBeInTheDocument();
    expect(screen.getByLabelText('Details: src/routes.ts')).toBeInTheDocument();
  });
});
