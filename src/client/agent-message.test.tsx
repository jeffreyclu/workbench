// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentMessageBody } from './agent-message';
import { splitAgentResponse } from './agent-message-logic';

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
});
