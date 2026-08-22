import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownCode, MarkdownPre } from './markdown-code.js';
import { hideWorkbenchControlBlocks, humanizeRunOutput, humanizeRunOutputBlocks } from './run-output';

const LIVE_RUN_OUTPUT_PAGE_SIZE = 5;

export function LiveRunOutput({ output }: { output: string }) {
  const [visibleCount, setVisibleCount] = useState(LIVE_RUN_OUTPUT_PAGE_SIZE);
  const blocks = humanizeRunOutputBlocks(output);
  if (blocks.length === 0) return null;
  const hiddenCount = Math.max(0, blocks.length - visibleCount);
  const visibleBlocks = blocks.slice(hiddenCount);
  return (
    <div className="live-run-output">
      {hiddenCount > 0 && (
        <button type="button" className="show-more-activity-button" onClick={() => setVisibleCount((current) => current + LIVE_RUN_OUTPUT_PAGE_SIZE)}>
          Show earlier ({hiddenCount} more)
        </button>
      )}
      <pre aria-live="polite">{visibleBlocks.join('\n\n')}</pre>
    </div>
  );
}

export function AgentMessageBody({ body, running, conversationId, workItemId }: { body: string; running: boolean; conversationId?: string; workItemId?: string }) {
  const visibleBody = hideWorkbenchControlBlocks(running ? humanizeRunOutput(body) : body);
  if (!visibleBody) return null;
  return <div className="agent-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    code: MarkdownCode,
    pre: MarkdownPre,
    a: ({ href = '', children, ...props }) => {
      const external = /^(?:(?!file:)[a-z][a-z0-9+.-]*:|#)/i.test(href);
      const artifactHref = external ? href : `/api/artifacts/open?path=${encodeURIComponent(href)}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ''}${workItemId ? `&workItemId=${encodeURIComponent(workItemId)}` : ''}`;
      return <a {...props} href={artifactHref} target="_blank" rel="noreferrer">{children}</a>;
    },
  }}>{visibleBody}</ReactMarkdown></div>;
}
