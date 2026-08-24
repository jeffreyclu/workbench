import { useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownCode, MarkdownPre } from './markdown-code.js';
import { hideWorkbenchControlBlocks, humanizeRunOutput, humanizeRunOutputBlocks } from './run-output';

const LIVE_RUN_OUTPUT_PAGE_SIZE = 5;

export interface AgentResponseSection {
  title: string;
  body: string;
}

function headingTitle(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim();
}

/**
 * Turns an agent response into digestible visual sections without changing the
 * Markdown itself. Prefer authored headings; fall back to top-level blocks for
 * older replies that arrived as unstructured prose.
 */
export function splitAgentResponse(body: string): AgentResponseSection[] {
  const lines = body.trim().split('\n');
  const sections: AgentResponseSection[] = [];
  let currentTitle = 'Brief';
  let currentLines: string[] = [];
  let inFence = false;

  const pushSection = () => {
    const content = currentLines.join('\n').trim();
    if (content) sections.push({ title: currentTitle, body: content });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^#{1,2}\s+\S/.test(line)) {
      pushSection();
      currentTitle = headingTitle(line);
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  pushSection();

  if (sections.length > 1) return sections;

  // A report without headings should still scan as individual beats instead
  // of one monolithic card. Blank lines outside fenced code are safe breaks.
  const blocks: string[] = [];
  let blockLines: string[] = [];
  inFence = false;
  const pushBlock = () => {
    const content = blockLines.join('\n').trim();
    if (content) blocks.push(content);
    blockLines = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && !line.trim()) {
      pushBlock();
      continue;
    }
    blockLines.push(line);
  }
  pushBlock();

  if (blocks.length < 2) return sections;
  return blocks.map((content, index) => ({ title: index === 0 ? 'Brief' : `Detail ${String(index + 1).padStart(2, '0')}`, body: content }));
}

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
