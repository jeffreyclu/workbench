// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffConfidenceBubble } from './diff-confidence-bubble.js';

afterEach(cleanup);

describe('DiffConfidenceBubble', () => {
  it('holds a placeholder of the same shape while the model is still assessing, so blocks do not shift when scores land', () => {
    render(<DiffConfidenceBubble assessment={null} />);
    const bubble = screen.getByLabelText('AI assessment in progress');
    expect(bubble).toHaveClass('diff-confidence-bubble', 'diff-confidence-pending');
    expect(bubble).toHaveTextContent('AI scoring');
    expect(bubble).toHaveAttribute('aria-live', 'polite');
  });

  it('renders a high-risk score more prominently than a low-risk one', () => {
    const { container } = render(<>
      <DiffConfidenceBubble assessment={{ risk: 96, reasoning: 'The change touches auth with no visible caller check.' }} />
      <DiffConfidenceBubble assessment={{ risk: 12, reasoning: 'A local rename with no behavior change.' }} />
    </>);
    const [high, low] = Array.from(container.querySelectorAll<HTMLElement>('.diff-confidence-bubble'));
    expect(high).toHaveTextContent('96');
    expect(Number(high.style.opacity)).toBeGreaterThan(Number(low.style.opacity));
    expect(Number(high.style.fontWeight)).toBeGreaterThan(Number(low.style.fontWeight));
    expect(high.style.color).not.toBe(low.style.color);
  });

  it('shows the recorded reasoning and forwards follow-up intent from the interactive details', () => {
    const onFollowUp = vi.fn();
    render(<DiffConfidenceBubble assessment={{ risk: 42, reasoning: 'The added call has no visible error path.' }} onFollowUp={onFollowUp} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI risk assessment: 42 out of 100' }));
    expect(screen.getByRole('dialog', { name: 'Risk assessment: 42 out of 100' })).toHaveTextContent('The added call has no visible error path.');
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' }));
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
