import { useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownCode, MarkdownPre } from './markdown-code.js';
import { hideWorkbenchControlBlocks, humanizeRunOutput, humanizeRunOutputBlocks } from './run-output';
import { splitAgentResponse } from './agent-message-logic';

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
  const sections = splitAgentResponse(visibleBody);
  const structured = sections.length > 1;
  const renderMarkdown = (content: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    code: MarkdownCode,
    pre: MarkdownPre,
    a: ({ href = '', children, ...props }) => {
      const external = /^(?:(?!file:)[a-z][a-z0-9+.-]*:|#)/i.test(href);
      const artifactHref = external ? href : `/api/artifacts/open?path=${encodeURIComponent(href)}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ''}${workItemId ? `&workItemId=${encodeURIComponent(workItemId)}` : ''}`;
      return <a {...props} href={artifactHref} target="_blank" rel="noreferrer">{children}</a>;
    },
  }}>{content}</ReactMarkdown>;

  if (!structured) return <div className="agent-markdown">{renderMarkdown(visibleBody)}</div>;

  return <div className="agent-response" aria-label={`Agent response in ${sections.length} parts`}>
    <div className="agent-response-deck">
      {sections.map((section, index) => <section key={`${section.title}-${index}`} className="agent-response-section" style={{ '--section-index': index } as CSSProperties}>
        <div className="agent-response-section-heading"><h3>{section.title}</h3></div>
        <div className="agent-markdown">{renderMarkdown(section.body)}</div>
      </section>)}
    </div>
  </div>;
}
