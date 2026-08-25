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

  it('marks live agent text for the streaming motion treatment', () => {
    const { container } = render(<AgentMessageBody body="Receiving output" running />);

    expect(container.querySelector('.agent-markdown')).toHaveClass('streaming');
  });

  it('reveals newly streamed text a character at a time instead of snapping in whole chunks', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Hello" running />);
    await waitForFrame();
    expect(container.textContent).toBe('Hello');

    rerender(<AgentMessageBody body="Hello, this is a much longer streamed chunk of text." running />);
    expect(container.textContent).toBe('Hello');

    await waitForFrame();
    const midway = container.textContent ?? '';
    expect(midway.length).toBeGreaterThan('Hello'.length);
    expect(midway.length).toBeLessThan('Hello, this is a much longer streamed chunk of text.'.length);
    expect('Hello, this is a much longer streamed chunk of text.'.startsWith(midway)).toBe(true);

    for (let i = 0; i < 20; i += 1) await waitForFrame();
    expect(container.textContent).toBe('Hello, this is a much longer streamed chunk of text.');
  });

  it('waits for a complete token before rendering streamed text', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Hello" running />);
    rerender(<AgentMessageBody body="Hello **Awaiting** next" running />);

    await waitForFrame();
    await waitForFrame();

    const visible = container.textContent ?? '';
    expect(visible).not.toMatch(/\*{1,2}[^*\s]*$/);
    expect('Hello **Awaiting** next'.startsWith(visible)).toBe(true);
    expect(['Hello', 'Hello ']).toContain(visible);
  });

  it('snaps streamed text to full once the message finishes running', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Streaming in" running />);
    rerender(<AgentMessageBody body="Streaming in, then finishing right away." running />);
    rerender(<AgentMessageBody body="Streaming in, then finishing right away." running={false} />);
    await waitForFrame();

    expect(container.textContent).toBe('Streaming in, then finishing right away.');
  });
});
