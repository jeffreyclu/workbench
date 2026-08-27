// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionFeedbackPrompt } from './session-feedback-prompt';

describe('SessionFeedbackPrompt', () => {
  it('requires one of the three ratings and cannot be dismissed with Escape or the backdrop', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SessionFeedbackPrompt onSubmit={onSubmit} />);
    expect(screen.getByRole('heading', { name: 'How did we do?' })).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.dialog-backdrop')!);
    expect(screen.getByRole('dialog')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    expect(onSubmit).toHaveBeenCalledWith('positive');
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });
});
