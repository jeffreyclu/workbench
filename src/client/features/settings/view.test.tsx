// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyboardHelpDialog, SettingsDialog } from './view';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Settings now hosts the AI provider selector, which asks the server whether
 * Palmyra is reachable before it renders its options. */
function renderSettings(onOpenKeyboardShortcuts: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SettingsDialog onClose={vi.fn()} onOpenKeyboardShortcuts={onOpenKeyboardShortcuts} /></QueryClientProvider>);
}

describe('SettingsDialog', () => {
  it('exposes keyboard shortcuts from Settings', () => {
    const onOpenKeyboardShortcuts = vi.fn();
    renderSettings(onOpenKeyboardShortcuts);

    const trigger = screen.getByRole('button', { name: 'View shortcuts' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);

    expect(onOpenKeyboardShortcuts).toHaveBeenCalledOnce();
  });

  it('offers the AI provider choice without waiting on availability', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderSettings(vi.fn());

    const selector = screen.getByRole('combobox', { name: 'Default AI provider' });
    expect(selector).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'AI: Palmyra' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'AI: Claude' })).toBeInTheDocument();

    fireEvent.change(selector, { target: { value: 'palmyra' } });
    expect(screen.getByRole('combobox', { name: 'Default AI provider' })).toHaveValue('palmyra');
  });
});

describe('KeyboardHelpDialog', () => {
  it('documents major navigation patterns and remains keyboard accessible', () => {
    const onClose = vi.fn();
    render(<KeyboardHelpDialog onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const close = screen.getByRole('button', { name: 'Close keyboard shortcuts' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby', 'keyboard-help-description');
    expect(screen.getByText('Search everything')).toBeInTheDocument();
    expect(screen.getByText('Move between queue items')).toBeInTheDocument();
    expect(screen.getByText('Next or previous pending decision')).toBeInTheDocument();
    expect(screen.getByText('Move between tabs and open that pane')).toBeInTheDocument();
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
