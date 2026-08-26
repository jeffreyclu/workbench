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

  it('renders a low score more prominently than a high one', () => {
    const { container } = render(<><DiffConfidenceBubble assessment={{ confidence: 12, reasoning: 'The visible branch is incomplete.' }} /><DiffConfidenceBubble assessment={{ confidence: 96, reasoning: 'The visible guard matches the changed call.' }} /></>);
    const [low, high] = Array.from(container.querySelectorAll<HTMLElement>('.diff-confidence-bubble'));
    expect(low).toHaveTextContent('12');
    expect(Number(low.style.opacity)).toBeGreaterThan(Number(high.style.opacity));
    expect(Number(low.style.fontWeight)).toBeGreaterThan(Number(high.style.fontWeight));
    expect(low.style.color).not.toBe(high.style.color);
  });

  it('shows the recorded reasoning and forwards follow-up intent from the interactive details', () => {
    const onFollowUp = vi.fn();
    render(<DiffConfidenceBubble assessment={{ confidence: 42, reasoning: 'The added call has no visible error path.' }} onFollowUp={onFollowUp} />);

    fireEvent.click(screen.getByRole('button', { name: 'AI assessment: 42 out of 100' }));
    expect(screen.getByRole('dialog', { name: 'Confidence assessment: 42 out of 100' })).toHaveTextContent('The added call has no visible error path.');
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' }));
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
