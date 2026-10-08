// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalLine, TerminalSessionInfo } from '../../../shared/contracts';
import { TerminalPanel } from './terminal-panel';
import { appendTerminalLines, MAX_TERMINAL_LINES } from './terminal-lines';

afterEach(cleanup);

const session = (overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo => ({ state: 'idle', pid: 4242, model: 'claude-opus', providerSessionId: 'sess-1', stopReason: null, ...overrides });
const line = (offset: number, kind: TerminalLine['kind'], text: string): TerminalLine => ({ offset, at: '2026-10-08T00:00:00Z', kind, text });
const renderPanel = (props: Partial<Parameters<typeof TerminalPanel>[0]> = {}) => render(<TerminalPanel conversationId="c1" agent="claude" lines={[]} session={null} error={null} {...props} />);

describe('TerminalPanel', () => {
  it('shows an empty state with the attach command before any session exists', () => {
    renderPanel({ session: session({ state: 'none', pid: null, model: null, providerSessionId: null }) });
    expect(screen.getByText('No session output yet. Send a message to start one.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('npx tsx scripts/attach-session.ts c1 claude')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('streams lines with state, PID, model and the live-session resume warning', () => {
    renderPanel({ session: session({ state: 'turn' }), lines: [line(0, 'host', '> hello'), line(10, 'delta', 'Hi there'), line(20, 'tool', '● Reading a.ts')] });
    expect(screen.getByRole('status')).toHaveTextContent('Working · PID 4242 · claude-opus');
    expect(screen.getByLabelText('claude session output')).toHaveTextContent('> hello');
    expect(screen.getByLabelText('claude session output')).toHaveTextContent('Hi there');
    expect(screen.getByRole('note')).toHaveTextContent('Do not run');
  });

  it('shows the stopped state without the resume warning', () => {
    renderPanel({ session: session({ state: 'stopped', pid: null, stopReason: 'idle' }), lines: [line(0, 'host', '· stopped')] });
    expect(screen.getByRole('note')).toHaveTextContent('Session stopped: idle');
    expect(screen.queryByText(/Do not run/)).not.toBeInTheDocument();
  });

  it('surfaces a read failure', () => {
    renderPanel({ error: 'boom' });
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});

describe('appendTerminalLines', () => {
  it('merges consecutive streaming fragments into one line', () => {
    const merged = appendTerminalLines([line(0, 'delta', 'Hel')], [line(5, 'delta', 'lo'), line(9, 'result', '↳ ok')]);
    expect(merged.map((entry) => entry.text)).toEqual(['Hello', '↳ ok']);
  });

  it('keeps only the most recent lines', () => {
    const many = Array.from({ length: MAX_TERMINAL_LINES + 5 }, (_, index) => line(index, 'text', String(index)));
    const result = appendTerminalLines([], many);
    expect(result).toHaveLength(MAX_TERMINAL_LINES);
    expect(result[0].text).toBe('5');
  });
});
