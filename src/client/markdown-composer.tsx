import { useEffect, useMemo } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { CodeNode } from '@lexical/code-core';
import { LinkNode } from '@lexical/link';
import { $getRoot, FORMAT_TEXT_COMMAND, KEY_ENTER_COMMAND, type EditorState, COMMAND_PRIORITY_HIGH } from 'lexical';
import { Bold, Code2, Italic, List, ListOrdered, Quote } from 'lucide-react';

type MarkdownComposerProps = {
  conversationId: string | null;
  value: string;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
};

function SubmitOnEnter({ onSubmit }: { onSubmit: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
    if (event?.shiftKey || event?.altKey || event?.ctrlKey || event?.metaKey || event?.isComposing) return false;
    event?.preventDefault();
    onSubmit();
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor, onSubmit]);
  return null;
}

function MarkdownToolbar() {
  const [editor] = useLexicalComposerContext();
  const format = (formatType: 'bold' | 'italic' | 'code') => editor.dispatchCommand(FORMAT_TEXT_COMMAND, formatType);
  return <div className="markdown-format-toolbar" aria-label="Format message">
    <button type="button" title="Bold" aria-label="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => format('bold')}><Bold size={13} /></button>
    <button type="button" title="Italic" aria-label="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => format('italic')}><Italic size={13} /></button>
    <button type="button" title="Inline code" aria-label="Inline code" onMouseDown={(event) => event.preventDefault()} onClick={() => format('code')}><Code2 size={13} /></button>
    <span />
    <button type="button" title="Bulleted list" aria-label="Bulleted list" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}><List size={13} /></button>
    <button type="button" title="Numbered list" aria-label="Numbered list" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}><ListOrdered size={13} /></button>
    <button type="button" title="Quote (type > at the start of a line)" aria-label="Quote hint" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.focus()}><Quote size={13} /></button>
  </div>;
}

function SyncMarkdownValue({ value }: { value: string }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const current = editor.getEditorState().read(() => $convertToMarkdownString(TRANSFORMERS));
    // The markdown serializer can add a trailing newline for a final block.
    // Do not replace the editor while the user is typing just because of that.
    if (current === value || current.replace(/\n$/, '') === value.replace(/\n$/, '')) return;
    editor.update(() => {
      $getRoot().clear();
      if (value) $convertFromMarkdownString(value, TRANSFORMERS);
    });
  }, [editor, value]);
  return null;
}

function SyncEditorEditable({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(!disabled), [disabled, editor]);
  return null;
}

function MarkdownEditor({ value, onChange, onSubmit, disabled }: Pick<MarkdownComposerProps, 'value' | 'onChange' | 'onSubmit' | 'disabled'>) {
  return <>
    <RichTextPlugin
      contentEditable={<ContentEditable
        className="markdown-contenteditable"
        aria-label="Message Codex or Claude"
        // Lexical's update listener is canonical; this keeps the controlled
        // draft current across browser/IME input events before that cycle ends.
        onInput={(event) => onChange(event.currentTarget.textContent ?? '')}
      />}
      placeholder={<div className="markdown-placeholder">Message Codex or Claude…</div>}
      ErrorBoundary={LexicalErrorBoundary}
    />
    <HistoryPlugin />
    <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
    <OnChangePlugin onChange={(editorState: EditorState) => editorState.read(() => onChange($convertToMarkdownString(TRANSFORMERS)))} />
    <SyncMarkdownValue value={value} />
    <SyncEditorEditable disabled={Boolean(disabled)} />
    {!disabled && <SubmitOnEnter onSubmit={onSubmit} />}
    <MarkdownToolbar />
  </>;
}

/** A Lexical editor that stores Markdown, keeping messages agent-readable. */
export function MarkdownComposer({ conversationId, value, onChange, onSubmit, disabled = false }: MarkdownComposerProps) {
  const initialConfig = useMemo(() => ({
    namespace: `workbench-markdown-${conversationId ?? 'new'}`,
    // Keep this in sync with `TRANSFORMERS`: MarkdownShortcutPlugin validates
    // every transformer's dependencies at startup.
    nodes: [HeadingNode, QuoteNode, CodeNode, ListNode, ListItemNode, LinkNode],
    editable: !disabled,
    onError: (error: Error) => { throw error; },
    editorState: () => { if (value) $convertFromMarkdownString(value, TRANSFORMERS); },
  }), [conversationId]);

  return <LexicalComposer key={conversationId ?? 'new'} initialConfig={initialConfig}>
    <MarkdownEditor value={value} onChange={onChange} onSubmit={onSubmit} disabled={disabled} />
  </LexicalComposer>;
}
