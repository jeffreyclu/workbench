// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffConfidenceBubble } from './diff-confidence-bubble.js';

afterEach(cleanup);

describe('DiffConfidenceBubble', () => {
  it('holds a placeholder of the same shape while the model is still assessing, so blocks do not shift when scores land', () => {
    render(<DiffConfidenceBubble confidence={null} />);
    const bubble = screen.getByLabelText('AI assessment in progress');
    expect(bubble).toHaveClass('diff-confidence-bubble', 'diff-confidence-pending');
    expect(bubble).toHaveTextContent('AI scoring');
    expect(bubble).toHaveAttribute('aria-live', 'polite');
  });

  it('renders a low score more prominently than a high one', () => {
    const { container } = render(<><DiffConfidenceBubble confidence={12} /><DiffConfidenceBubble confidence={96} /></>);
    const [low, high] = Array.from(container.querySelectorAll<HTMLElement>('.diff-confidence-bubble'));
    expect(low).toHaveTextContent('12');
    expect(Number(low.style.opacity)).toBeGreaterThan(Number(high.style.opacity));
    expect(Number(low.style.fontWeight)).toBeGreaterThan(Number(high.style.fontWeight));
    expect(low.style.color).not.toBe(high.style.color);
  });
});
