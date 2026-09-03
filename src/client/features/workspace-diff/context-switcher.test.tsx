// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceContextSwitcher } from './context-switcher.js';

const options = [
  { path: '/tmp/repository-a', label: 'repository-a' },
  { path: '/tmp/repository-b', label: 'repository-b' },
];

afterEach(cleanup);

describe('WorkspaceContextSwitcher', () => {
  it('holds the requested repository through a stale authoritative render', async () => {
    let complete!: () => void;
    const onSelect = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const { rerender } = render(<WorkspaceContextSwitcher selectedPath={options[0].path} options={options} onSelect={onSelect} />);
    const selector = screen.getByLabelText('Workspace');

    fireEvent.change(selector, { target: { value: options[1].path } });
    expect(selector).toHaveValue(options[1].path);
    expect(selector).toBeDisabled();
    rerender(<WorkspaceContextSwitcher selectedPath={options[0].path} options={options} onSelect={onSelect} />);
    expect(selector).toHaveValue(options[1].path);

    complete();
    rerender(<WorkspaceContextSwitcher selectedPath={options[1].path} options={options} onSelect={onSelect} />);
    await waitFor(() => expect(selector).toBeEnabled());
    expect(selector).toHaveValue(options[1].path);
  });

  it('rolls back to the confirmed repository when switching fails', async () => {
    const onSelect = vi.fn().mockRejectedValue(new Error('Repository unavailable.'));
    render(<WorkspaceContextSwitcher selectedPath={options[0].path} options={options} onSelect={onSelect} />);

    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: options[1].path } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Repository unavailable.');
    expect(screen.getByLabelText('Workspace')).toHaveValue(options[0].path);
  });
});
