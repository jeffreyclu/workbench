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

    expect(container.querySelector('.live-run-output')).toBeInTheDocument();
    expect(container.querySelector('.agent-response')).toBeNull();
    expect(screen.getByText('Receiving output')).toBeInTheDocument();
  });

  it('renders live activity immediately instead of treating it as a typed final reply', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Hello" running />);
    await waitForFrame();
    expect(container.textContent).toBe('Hello');

    rerender(<AgentMessageBody body="Hello, this is a much longer streamed chunk of text." running />);
    expect(container.textContent).toBe('Hello, this is a much longer streamed chunk of text.');
    expect(container.querySelector('.agent-response')).toBeNull();
  });

  it('uses separate activity items for progress blocks', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Hello" running />);
    rerender(<AgentMessageBody body={'● Inspecting repository\n\n● Running tests'} running />);

    await waitForFrame();
    expect(container.querySelectorAll('.live-run-output li')).toHaveLength(2);
    expect(container.textContent).toContain('Inspecting repository');
    expect(container.textContent).toContain('Running tests');
  });

  it('snaps streamed text to full once the message finishes running', async () => {
    const { container, rerender } = render(<AgentMessageBody body="Streaming in" running />);
    rerender(<AgentMessageBody body="Streaming in, then finishing right away." running />);
    rerender(<AgentMessageBody body="Streaming in, then finishing right away." running={false} />);
    await waitForFrame();

    expect(container.textContent).toBe('Streaming in, then finishing right away.');
  });
});
