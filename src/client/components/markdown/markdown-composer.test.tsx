// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

  it('turns an IDE-style HTML paste into a fenced code block instead of mangled paragraphs', async () => {
    render(<ControlledComposer initial="" />);
    const editor = await screen.findByRole('textbox', { name: 'Test editor' });

    // jsdom does not implement geometry; Lexical reads it while scrolling the
    // caret into view once a selection lands inside the editor.
    const zeroRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const originalElementRect = Element.prototype.getBoundingClientRect;
    const originalRangeRect = Range.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = zeroRect;
    Range.prototype.getBoundingClientRect = zeroRect;

    try {
      editor.focus();

      const html = '<div style="font-family: Menlo, monospace;"><div>function greet() {</div><div>&nbsp;&nbsp;return 1;</div><div>}</div></div>';
      const text = 'function greet() {\n  return 1;\n}';
      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: { getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? text : '') },
      });
      editor.dispatchEvent(pasteEvent);

      await waitFor(() => expect(editor.querySelector('pre, code')).not.toBeNull());
      expect(editor.textContent).toContain('function greet()');
      expect(editor.textContent).toContain('return 1;');
      expect(editor.querySelectorAll('p').length).toBe(0);
    } finally {
      Element.prototype.getBoundingClientRect = originalElementRect;
      Range.prototype.getBoundingClientRect = originalRangeRect;
    }
  });
});
