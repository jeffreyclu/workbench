import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function CopyCodeButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="copy-code-button" aria-label="Copy code to clipboard" title="Copy code" onClick={async () => {
    await copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }}>
    {copied ? <Check size={13} /> : <Copy size={13} />}<span>{copied ? 'Copied' : 'Copy'}</span>
  </button>;
}
