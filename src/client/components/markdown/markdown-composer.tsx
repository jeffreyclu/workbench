import { useEffect, useMemo, useRef } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown';
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, $isListItemNode, ListNode, ListItemNode } from '@lexical/list';
import { $createQuoteNode, $isQuoteNode, HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $createCodeNode, $isCodeNode, CodeNode } from '@lexical/code-core';
import { LinkNode } from '@lexical/link';
import { $createTextNode, $getRoot, $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, KEY_ENTER_COMMAND, PASTE_COMMAND, type EditorState, type LexicalNode, COMMAND_PRIORITY_HIGH } from 'lexical';
import { Bold, Code2, Italic, List, ListOrdered, Quote } from 'lucide-react';

type MarkdownComposerProps = {
  conversationId: string | null;
  value: string;
  onChange: (markdown: string) => void;
  /** Enter submits only where the surrounding UI explicitly opts into it. */
  onSubmit?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  className?: string;
  disabled?: boolean;
};

function SubmitOnEnter({ onSubmit }: { onSubmit: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
    if (event?.shiftKey || event?.altKey || event?.ctrlKey || event?.metaKey || event?.isComposing) return false;
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      let node: LexicalNode | null = selection.anchor.getNode();
      // Enter continues structured blocks. Only an ordinary paragraph sends.
      while (node) {
        if ($isListItemNode(node) || $isQuoteNode(node) || $isCodeNode(node)) return false;
        node = node.getParent();
      }
    }
    event?.preventDefault();
    onSubmit();
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor, onSubmit]);
  return null;
}

// An IDE's clipboard HTML wraps every source line in its own block element and
// spells out indentation with runs of &nbsp;. Lexical's generic HTML importer
// turns each of those per-line blocks into a separate paragraph and keeps the
// literal non-breaking spaces, so a pasted function comes out as one blank-line-
// separated "paragraph" per source line with mangled indentation. The
// text/plain flavor of the same clipboard payload still has real newlines and
// real spaces, so route anything that looks like an IDE/code paste through a
// code block built from that plain text instead of the mangled HTML.
const IDE_PASTE_HTML_PATTERN = /white-space:\s*pre|font-family:[^;"']*(mono|consolas|courier|menlo|monaco|cascadia|jetbrains|fira\s*code|sf\s*mono)|(?:&nbsp;){2,}|<pre[\s>]/i;

function looksLikeIdePaste(html: string, text: string): boolean {
  return text.includes('\n') && IDE_PASTE_HTML_PATTERN.test(html);
}

function CodePastePlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(PASTE_COMMAND, (event) => {
    const clipboardData = (event as ClipboardEvent | null)?.clipboardData;
    if (!clipboardData) return false;
    const html = clipboardData.getData('text/html');
    const text = clipboardData.getData('text/plain');
    if (!looksLikeIdePaste(html, text)) return false;
    event.preventDefault();
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const codeNode = $createCodeNode();
      // Non-breaking spaces are how HTML preserves indentation visually; a code
      // block cares about real ones.
      codeNode.append($createTextNode(text.replace(/\u00a0/g, ' ')));
      selection.insertNodes([codeNode]);
    });
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor]);
  return null;
}

function MarkdownToolbar() {
  const [editor] = useLexicalComposerContext();
  const format = (formatType: 'bold' | 'italic' | 'code') => editor.dispatchCommand(FORMAT_TEXT_COMMAND, formatType);
  const quote = () => editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    const block = selection.anchor.getNode().getTopLevelElement();
    if (!block || $isQuoteNode(block)) return;
    const quoteNode = $createQuoteNode();
    block.replace(quoteNode);
    quoteNode.append(block);
  });
  return <div className="markdown-format-toolbar" aria-label="Format message">
    <button type="button" title="Bold" aria-label="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => format('bold')}><Bold size={13} /></button>
    <button type="button" title="Italic" aria-label="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => format('italic')}><Italic size={13} /></button>
    <button type="button" title="Inline code" aria-label="Inline code" onMouseDown={(event) => event.preventDefault()} onClick={() => format('code')}><Code2 size={13} /></button>
    <span />
    <button type="button" title="Bulleted list" aria-label="Bulleted list" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}><List size={13} /></button>
    <button type="button" title="Numbered list" aria-label="Numbered list" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}><ListOrdered size={13} /></button>
    <button type="button" title="Quote" aria-label="Quote" onMouseDown={(event) => event.preventDefault()} onClick={quote}><Quote size={13} /></button>
  </div>;
}

function SyncMarkdownValue({ value, onChange }: { value: string; onChange: (markdown: string) => void }) {
  const [editor] = useLexicalComposerContext();
  const lastEmittedValue = useRef<string | null>(null);
  useEffect(() => {
    const current = editor.getEditorState().read(() => $convertToMarkdownString(TRANSFORMERS));
    // The markdown serializer can add a trailing newline for a final block.
    // Do not replace the editor while the user is typing just because of that.
    if (current === value || current.replace(/\n$/, '') === value.replace(/\n$/, '')) return;
    // Parent state normally echoes this editor's own markdown back immediately.
    // Never replace Lexical's tree for that echo: doing so breaks IME composition
    // and throws away the current selection. A genuinely external value still
    // replaces the document (conversation switch, draft restore, reset, etc.).
    if (lastEmittedValue.current === value) return;
    editor.update(() => {
      $getRoot().clear();
      if (value) $convertFromMarkdownString(value, TRANSFORMERS);
    });
  }, [editor, value]);
  return <OnChangePlugin onChange={(editorState: EditorState) => editorState.read(() => {
    const markdown = $convertToMarkdownString(TRANSFORMERS);
    lastEmittedValue.current = markdown;
    onChange(markdown);
  })} />;
}

function SyncEditorEditable({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(!disabled), [disabled, editor]);
  return null;
}

function FocusEditor({ autoFocus }: { autoFocus: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!autoFocus) return;
    const timeout = window.setTimeout(() => editor.getRootElement()?.focus());
    return () => window.clearTimeout(timeout);
  }, [autoFocus, editor]);
  return null;
}

function MarkdownEditor({ value, onChange, onSubmit, onFocus, onBlur, disabled, placeholder = 'Write in Markdown…', ariaLabel = 'Markdown editor', autoFocus = false, className }: Pick<MarkdownComposerProps, 'value' | 'onChange' | 'onSubmit' | 'onFocus' | 'onBlur' | 'disabled' | 'placeholder' | 'ariaLabel' | 'autoFocus' | 'className'>) {
  return <div className={['markdown-composer', className].filter(Boolean).join(' ')}>
    <RichTextPlugin
      contentEditable={<ContentEditable
        className="markdown-contenteditable"
        aria-label={ariaLabel}
        onFocus={onFocus}
        onBlur={onBlur}
      />}
      placeholder={<div className="markdown-placeholder">{placeholder}</div>}
      ErrorBoundary={LexicalErrorBoundary}
    />
    <HistoryPlugin />
    <ListPlugin />
    <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
    <CodePastePlugin />
    <SyncMarkdownValue value={value} onChange={onChange} />
    <SyncEditorEditable disabled={Boolean(disabled)} />
    <FocusEditor autoFocus={autoFocus} />
    {!disabled && onSubmit && <SubmitOnEnter onSubmit={onSubmit} />}
    {!disabled && <MarkdownToolbar />}
  </div>;
}

/** A Lexical editor that stores Markdown, keeping messages agent-readable. */
export function MarkdownComposer({ conversationId, value, onChange, onSubmit, onFocus, onBlur, placeholder, ariaLabel, autoFocus, className, disabled = false }: MarkdownComposerProps) {
  const initialConfig = useMemo(() => ({
    namespace: `workbench-markdown-${conversationId ?? 'new'}`,
    // Keep this in sync with `TRANSFORMERS`: MarkdownShortcutPlugin validates
    // every transformer's dependencies at startup.
    nodes: [HeadingNode, QuoteNode, CodeNode, ListNode, ListItemNode, LinkNode],
    editable: !disabled,
    onError: (error: Error) => { throw error; },
    editorState: () => { if (value) $convertFromMarkdownString(value, TRANSFORMERS); },
  // This configuration is intentionally initialized once per conversation;
  // changing draft text or the disabled state must not recreate the editor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [conversationId]);

  return <LexicalComposer key={conversationId ?? 'new'} initialConfig={initialConfig}>
    <MarkdownEditor value={value} onChange={onChange} onSubmit={onSubmit} onFocus={onFocus} onBlur={onBlur} placeholder={placeholder} ariaLabel={ariaLabel} autoFocus={autoFocus} className={className} disabled={disabled} />
  </LexicalComposer>;
}
