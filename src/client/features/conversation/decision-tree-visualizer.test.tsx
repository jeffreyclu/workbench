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
  cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null,
  estimatedCostUsd: null, costSource: null,
  fallbackFrom: null, fallbackReason: null, dispatchTarget: 'codex', dispatchGroupId: null,
  attempt: 0, maxAttempts: 3, nextAttemptAt: null, queuePriority: 0, retrievedMemoryCount: null,
}, {
  id: 'stream', conversationId: 'conversation', author: 'codex', body: '', pinned: false,
  status: 'running', error: '', createdAt: '2026-08-25T12:00:01.000Z', completedAt: null,
  attachments: [], model: 'gpt-5.6', accountProfile: 'default', executionProfile: 'standard', inputTokens: null,
  cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null,
  estimatedCostUsd: null, costSource: null,
  fallbackFrom: null, fallbackReason: null, dispatchTarget: 'none', dispatchGroupId: 'request',
  attempt: 0, maxAttempts: 3, nextAttemptAt: null, queuePriority: 0, retrievedMemoryCount: 2,
}];

describe('DecisionTreeVisualizer', () => {
  afterEach(cleanup);

  it('starts with agent branches collapsed and expands their hierarchy when clicked', () => {
    render(<DecisionTreeVisualizer messages={messages} events={[
      { id: 'decision', messageId: 'stream', runId: null, kind: 'decision', detail: 'Check the existing tests before changing behavior.', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'tool', messageId: 'stream', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:02.000Z' },
    ]} isLoadingEvents={false} onClose={vi.fn()} />);

    expect(screen.getByRole('list', { name: 'Agent decision tree' })).toBeInTheDocument();
    expect(screen.getByText('Requested Codex')).toBeInTheDocument();
    expect(screen.getByText('Debug this')).toBeInTheDocument();
    expect(screen.getByText('Brief')).toBeInTheDocument();
    const branches = screen.getByText('1 agent branch').closest('details')!;
    expect(branches).not.toHaveAttribute('open');
    expect(screen.getByRole('region', { name: 'Codex agent stream' })).not.toBeVisible();

    fireEvent.click(screen.getByText('1 agent branch'));

    expect(branches).toHaveAttribute('open');
    expect(screen.getByRole('region', { name: 'Codex agent stream' })).toBeVisible();
    expect(screen.getAllByText('Check the existing tests before changing behavior.')).toHaveLength(1);
    expect(screen.getByText('Ran the test suite.')).toBeInTheDocument();
    expect(screen.getByText('Decision · Why')).toBeInTheDocument();
    expect(screen.getByText('Ran the test suite.').closest('.decision-tree-decision-branch')).toContainElement(screen.getByText('Check the existing tests before changing behavior.'));
  });

  it('updates the open debugger as live decisions and tool calls arrive', () => {
    const onClose = vi.fn();
    const { rerender } = render(<DecisionTreeVisualizer messages={messages} events={[]} isLoadingEvents onClose={onClose} />);

    expect(screen.getByText('Loading agent events…')).toBeInTheDocument();
    expect(screen.getByText('Waiting for recorded decisions or tool calls.')).toBeInTheDocument();

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
    expect(screen.getAllByText('Confirm the new behavior before testing it.')).toHaveLength(1);
  });

  it('does not invent a missing decision summary for calls without one', () => {
    const onClose = vi.fn();
    render(<DecisionTreeVisualizer messages={messages} events={[{
      id: 'tool', messageId: 'stream', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:02.000Z',
    }]} isLoadingEvents={false} onClose={onClose} />);

    expect(screen.getByText('Ran the test suite.')).toBeInTheDocument();
    expect(screen.getByText('No recorded decision')).toBeInTheDocument();
    expect(screen.getByText('These calls were captured without a provider-authored Why.')).toBeInTheDocument();
  });

  it('keeps Claude events in their own agent stream', () => {
    render(<DecisionTreeVisualizer messages={[...messages.slice(0, 1), { ...messages[1], id: 'claude-stream', author: 'claude' }]} events={[
      { id: 'claude-decision', messageId: 'claude-stream', runId: null, kind: 'decision', detail: 'Inspect the route before editing it.', createdAt: '2026-08-25T12:00:01.000Z' },
      { id: 'claude-read', messageId: 'claude-stream', runId: null, kind: 'file_read', detail: 'src/routes.ts', createdAt: '2026-08-25T12:00:02.000Z' },
    ]} isLoadingEvents={false} onClose={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Claude agent stream' })).toBeInTheDocument();
    expect(screen.getAllByText('Inspect the route before editing it.')).toHaveLength(1);
    expect(screen.getByText('Read src/routes.ts.')).toBeInTheDocument();
  });

  it('shows raw details on hover and keyboard focus without an inspect button', () => {
    const onClose = vi.fn();
    render(<DecisionTreeVisualizer messages={messages} events={[
      { id: 'tool', messageId: 'stream', runId: null, kind: 'tool', detail: 'command_execution: npm test', createdAt: '2026-08-25T12:00:02.000Z' },
    ]} isLoadingEvents={false} onClose={onClose} />);

    const toolCall = screen.getByText('Ran the test suite.').closest('article')!;
    expect(screen.queryByRole('button', { name: /inspect/i })).not.toBeInTheDocument();
    fireEvent.mouseEnter(toolCall);
    expect(screen.getByText('command_execution: npm test')).toBeInTheDocument();
    fireEvent.mouseLeave(toolCall);
    expect(screen.queryByText('command_execution: npm test')).not.toBeInTheDocument();
    fireEvent.focus(toolCall);
    expect(screen.getByText('command_execution: npm test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close decision tree' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
