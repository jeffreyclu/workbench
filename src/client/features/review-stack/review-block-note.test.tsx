// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewBlockNote } from './review-block-note.js';

afterEach(cleanup);

const props = { note: null, saving: false, error: null, onSave: () => undefined };

describe('ReviewBlockNote', () => {
  it('shows what was already said about the block without opening the composer', () => {
    render(<ReviewBlockNote {...props} blockId="b1" note="The null check moved below the read." />);
    expect(screen.getByText('The null check moved below the read.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Comment on this block' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit the comment on this block' })).toBeInTheDocument();
  });

  it('refuses both verdicts until something has actually been written', async () => {
    render(<ReviewBlockNote {...props} blockId="b1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on this block' }));

    expect(await screen.findByRole('textbox', { name: 'Comment on this block' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Comment/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Request changes/ })).toBeDisabled();
  });

  it('closes on the next block, so a half-written note cannot land on other code', async () => {
    const view = render(<ReviewBlockNote {...props} blockId="b1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on this block' }));
    await screen.findByRole('textbox', { name: 'Comment on this block' });

    view.rerender(<ReviewBlockNote {...props} blockId="b2" />);
    expect(screen.queryByRole('textbox', { name: 'Comment on this block' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Comment on this block' })).toBeInTheDocument();
  });

  it('reports a failed save instead of dropping the comment silently', () => {
    render(<ReviewBlockNote {...props} blockId="b1" error="offline" />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on this block' }));
    expect(screen.getByRole('alert')).toHaveTextContent('offline');
  });

});
