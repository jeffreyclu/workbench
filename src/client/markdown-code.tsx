import { isValidElement, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { CopyCodeButton } from './copy-code.js';

/** Inline code stays inline; fenced code is handled by the surrounding pre element. */
export function MarkdownCode({ className, children, ...props }: ComponentPropsWithoutRef<'code'>) {
  return <code className={className} {...props}>{children}</code>;
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return isValidElement<{ children?: ReactNode }>(node) ? textContent(node.props.children) : '';
}

/** Every fenced block has a pre, whether or not its Markdown included a language tag. */
export function MarkdownPre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  return <pre {...props}><CopyCodeButton text={textContent(children).replace(/\n$/, '')} />{children}</pre>;
}
