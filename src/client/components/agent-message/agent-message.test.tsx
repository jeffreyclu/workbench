// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentMessageBody } from './agent-message';
import { splitAgentResponse } from './agent-message-logic';

async function waitForFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe('splitAgentResponse', () => {
  it('uses authored top-level headings as report sections', () => {
    expect(splitAgentResponse('Intro.\n\n## Decision\nShip it.\n\n## Verification\nTests pass.')).toEqual([
      { title: 'Brief', body: 'Intro.' },
      { title: 'Decision', body: 'Ship it.' },
      { title: 'Verification', body: 'Tests pass.' },
    ]);
  });

  it('keeps headings inside fenced code in the same section', () => {
    expect(splitAgentResponse('```md\n## Not a report heading\n```\n\nDone.')).toEqual([
      { title: 'Brief', body: '```md\n## Not a report heading\n```' },
      { title: 'Detail 02', body: 'Done.' },
    ]);
  });

  it('breaks unstructured multi-paragraph replies into readable beats', () => {
    expect(splitAgentResponse('First update.\n\nSecond update.')).toEqual([
      { title: 'Brief', body: 'First update.' },
      { title: 'Detail 02', body: 'Second update.' },
    ]);
  });

  it('groups a plain line-per-block reply into a bounded number of detail bubbles instead of one per line', () => {
    const lines = ['Line one.', 'Line two.', 'Line three.', 'Line four.', 'Line five.', 'Line six.'];
    expect(splitAgentResponse(lines.join('\n\n'))).toEqual([
      { title: 'Brief', body: 'Line one.\n\nLine two.' },
      { title: 'Detail 02', body: 'Line three.\n\nLine four.' },
      { title: 'Detail 03', body: 'Line five.\n\nLine six.' },
    ]);
  });

  it('keeps structured replies focused on their content instead of rendering a response map', () => {
    render(<AgentMessageBody body={'## Decision\nShip it.\n\n## Verification\nTests pass.'} running={false} />);

    expect(screen.getByLabelText('Agent response in 2 parts')).toBeInTheDocument();
    expect(screen.queryByLabelText('Response sections')).not.toBeInTheDocument();
    expect(screen.queryByText('Response map')).not.toBeInTheDocument();
  });

  it('renders section labels without a synthetic index', () => {
    const { container } = render(<AgentMessageBody body={'## Decision\nShip it.\n\n## Verification\nTests pass.'} running={false} />);

    expect(container.querySelector('h3')?.textContent).toBe('Decision');
    expect(container.querySelector('.agent-response-section-heading > span')).toBeNull();
  });

  it('wraps a single completed reply in a detail bubble when requested by the shared room', () => {
    const { container } = render(<AgentMessageBody body="One concise update." running={false} detailForSingle />);

    expect(screen.getByLabelText('Agent response in 1 part')).toBeInTheDocument();
    expect(container.querySelectorAll('.agent-response-section')).toHaveLength(1);
    expect(container.querySelector('.agent-response-section-heading h3')?.textContent).toBe('Detail');
    expect(container.textContent).toContain('One concise update.');
  });

  it('marks live agent text for the streaming motion treatment', () => {
    const { container } = render(<AgentMessageBody body="Receiving output" running />);

    expect(container.querySelector('.live-run-output')).toBeInTheDocument();
    expect(container.querySelector('.agent-response')).toBeNull();
    expect(screen.getByText('Receiving output')).toBeInTheDocument();
  });

  it('keeps the live activity surface visible while a reply starts with no text', () => {
    const { container } = render(<AgentMessageBody body="" running />);

    expect(container.querySelector('[aria-label="Live agent activity"]')).toBeInTheDocument();
    expect(container.textContent).toContain('Agent is starting');
    expect(container.querySelector('.live-run-output-starting')).toBeInTheDocument();
    expect(container.querySelector('.live-run-output-skeleton')).toBeInTheDocument();
  });

  it('typewrites newly received live activity without replacing the activity surface', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Hello" running />);
    await waitForFrame();
    expect(container.textContent).toBe('Hello');

    rerender(<AgentMessageBody body="Hello, this is a much longer streamed chunk of text." running />);
    expect(container.textContent).not.toBe('Hello, this is a much longer streamed chunk of text.');
    expect(container.querySelector('.agent-response')).toBeNull();
  });

  it('continues a growing paragraph without remounting or replaying its revealed prefix', () => {
    const { container, rerender } = render(<AgentMessageBody body="First paragraph" running />);
    const paragraph = container.querySelector('.live-run-output li');

    expect(paragraph).toHaveTextContent('First paragraph');

    rerender(<AgentMessageBody body="First paragraph continues with streamed text" running />);

    expect(container.querySelector('.live-run-output li')).toBe(paragraph);
    expect(paragraph).toHaveTextContent('First paragraph');
  });

  it('uses separate activity items for progress blocks', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Hello" running />);
    rerender(<AgentMessageBody body={'● Inspecting repository\n\n● Running tests'} running />);

    await waitForFrame();
    expect(container.querySelectorAll('.live-run-output li')).toHaveLength(2);
    expect(container.textContent).not.toContain('Inspecting repository');
    expect(container.textContent).not.toContain('Running tests');
  });

  it('keeps an interjection at the activity boundary where it arrived', () => {
    const { container, rerender } = render(<AgentMessageBody body={'● Inspecting\n\n● Reading files'} running />);
    rerender(<AgentMessageBody
      body={'● Inspecting\n\n● Reading files'}
      running
      interjections={[{ id: 'interjection-1', body: 'Focus on the failure.', pending: false }]}
    />);
    rerender(<AgentMessageBody
      body={'● Inspecting\n\n● Reading files\n\n● Running tests'}
      running
      interjections={[{ id: 'interjection-1', body: 'Focus on the failure.', pending: false }]}
    />);

    expect(Array.from(container.querySelectorAll('.live-run-output li')).map((item) => item.textContent)).toEqual([
      'Inspecting',
      'Reading files',
      'You interjectedFocus on the failure.',
      '',
    ]);
  });

  it('uses the persisted interjection boundary after remounting the live stream', () => {
    const { container } = render(<AgentMessageBody
      body={'● Inspecting\n\n● Reading files\n\n● Running tests'}
      running
      interjections={[{ id: 'interjection-1', body: 'Focus on the failure.', pending: false, streamOffset: 2 }]}
    />);

    expect(Array.from(container.querySelectorAll('.live-run-output li')).map((item) => item.textContent)).toEqual([
      'Inspecting',
      'Reading files',
      'You interjectedFocus on the failure.',
      'Running tests',
    ]);
  });

  it('snaps streamed text to full once the message finishes running', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Streaming in" running />);
    rerender(<AgentMessageBody body="Streaming in, then finishing right away." running />);
    rerender(<AgentMessageBody body="Streaming in, then finishing right away." running={false} />);
    await waitForFrame();

    expect(container.textContent).toBe('Streaming in, then finishing right away.');
  });
});
