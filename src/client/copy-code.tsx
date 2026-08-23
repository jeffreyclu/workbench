import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { copyText } from './clipboard';

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
