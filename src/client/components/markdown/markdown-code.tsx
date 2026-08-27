import { isValidElement, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { CopyCodeButton } from './copy-code.js';
import { highlightHtml, resolveLanguage } from './syntax-highlight.js';

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return isValidElement<{ children?: ReactNode }>(node) ? textContent(node.props.children) : '';
}

/** Inline code stays inline; fenced code (marked by react-markdown's `language-x` className) is syntax-highlighted. */
export function MarkdownCode({ className, children, ...props }: ComponentPropsWithoutRef<'code'>) {
  const language = resolveLanguage(/language-(\S+)/.exec(className ?? '')?.[1]);
  if (!language) return <code className={className} {...props}>{children}</code>;
  const html = highlightHtml(textContent(children).replace(/\n$/, ''), language);
  return <code className={className} {...props} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Every fenced block has a pre, whether or not its Markdown included a language tag. */
export function MarkdownPre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  return <pre {...props}><CopyCodeButton text={textContent(children).replace(/\n$/, '')} />{children}</pre>;
}
