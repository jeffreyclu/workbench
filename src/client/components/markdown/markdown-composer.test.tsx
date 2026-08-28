// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownComposer } from './markdown-composer.js';

function ControlledComposer({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownComposer conversationId="editor-test" value={value} onChange={setValue} ariaLabel="Test editor" />;
}

afterEach(cleanup);

describe('MarkdownComposer', () => {
  it('keeps all controls inside Lexical and does not inject DOM-owned code controls', async () => {
    render(<ControlledComposer initial={'```ts\nconst value = 1;\n```'} />);

    await screen.findByRole('textbox', { name: 'Test editor' });
    expect(document.querySelector('.copy-code-button')).toBeNull();
    expect(document.querySelector('.markdown-contenteditable pre button')).toBeNull();
  });

  it('keeps the editor read-only without leaving an active formatting toolbar behind', async () => {
    render(<MarkdownComposer conversationId="disabled-editor" value="Read only" onChange={() => undefined} ariaLabel="Read-only editor" disabled />);

    const editor = await screen.findByRole('textbox', { name: 'Read-only editor' });
    await waitFor(() => expect(editor).toHaveAttribute('contenteditable', 'false'));
    expect(screen.queryByRole('group', { name: 'Format message' })).toBeNull();
  });

  it('renders Markdown lists through Lexical list nodes', async () => {
    render(<ControlledComposer initial={'- First task\n- Second task'} />);
    const editor = await screen.findByRole('textbox', { name: 'Test editor' });

    await waitFor(() => expect(editor.querySelector('ul')).not.toBeNull());
    expect(screen.getByRole('button', { name: 'Bulleted list' })).toBeVisible();
  });
});
