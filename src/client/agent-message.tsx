import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownCode, MarkdownPre } from './markdown-code.js';
import { hideWorkbenchControlBlocks, humanizeRunOutput, humanizeRunOutputBlocks } from './run-output';
import { splitAgentResponse } from './agent-message-logic';

const LIVE_RUN_OUTPUT_PAGE_SIZE = 5;
const TYPEWRITER_BASE_CHARS_PER_SEC = 60;
const TYPEWRITER_BACKLOG_CATCHUP_RATE = 5;

// The animation may advance its internal character counter through a word, but
// rendering that partial slice makes prose and Markdown visibly break (for
// example, `**Awa`). Keep the visible edge at a completed token until the
// whole message is ready.
function completedTokenLength(text: string, revealLength: number): number {
  if (revealLength >= text.length) return text.length;
  const lastWhitespace = text.lastIndexOf(' ', revealLength - 1);
  const lastNewline = text.lastIndexOf('\n', revealLength - 1);
  const boundary = Math.max(lastWhitespace, lastNewline);
  return boundary < 0 ? 0 : boundary + 1;
}

// Streamed bodies arrive in server-paced network chunks, not per-character; this reveals
// the buffered text at a smooth per-character pace so it reads as a typewriter instead of
// snapping in per chunk. Backlog-proportional speed keeps large chunks from lagging behind.
function useTypewriter(text: string, active: boolean): string {
  const [revealed, setRevealed] = useState(text.length);
  const textRef = useRef(text);
  const previousTextRef = useRef(text);
  const revealedRef = useRef(revealed);
  textRef.current = text;
  revealedRef.current = revealed;

  useEffect(() => {
    previousTextRef.current = text;
  }, [text]);

  useEffect(() => {
    if (text.length < revealedRef.current) {
      revealedRef.current = text.length;
      setRevealed(text.length);
    }
  }, [text]);

  useEffect(() => {
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!active || reducedMotion) {
      if (revealedRef.current !== textRef.current.length) setRevealed(textRef.current.length);
      return;
    }
    let frame = 0;
    let lastTime: number | null = null;
    const step = (time: number) => {
      const dt = lastTime === null ? 0 : time - lastTime;
      lastTime = time;
      const target = textRef.current.length;
      setRevealed((current) => {
        if (current >= target) return current;
        const backlog = target - current;
        const charsPerSec = TYPEWRITER_BASE_CHARS_PER_SEC + backlog * TYPEWRITER_BACKLOG_CATCHUP_RATE;
        return Math.min(target, current + Math.max(1, Math.round((charsPerSec * dt) / 1000)));
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // A server chunk can extend the final word of the last rendered chunk
  // (`Hello` -> `Hello, ...`). Keep that completed prefix visible while the
  // next token catches up instead of briefly replacing it with nothing.
  const preservedPrefixLength = text.startsWith(previousTextRef.current) && revealed >= previousTextRef.current.length
    ? previousTextRef.current.length
    : 0;
  return text.slice(0, Math.max(completedTokenLength(text, revealed), preservedPrefixLength));
}

function StreamingMarkdown({ content, streaming, renderMarkdown }: { content: string; streaming: boolean; renderMarkdown: (content: string) => ReactElement }) {
  const revealed = useTypewriter(content, streaming);
  return renderMarkdown(revealed);
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
  const sectionIdPrefix = useId();
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

  if (!structured) return <div className={`agent-markdown${running ? ' streaming' : ''}`}><StreamingMarkdown content={visibleBody} streaming={running} renderMarkdown={renderMarkdown} /></div>;

  const lastIndex = sections.length - 1;
  return <div className="agent-response" role="group" aria-label={`Agent response in ${sections.length} parts`}>
    <div className="agent-response-deck">
      {sections.map((section, index) => {
        const headingId = `${sectionIdPrefix}-${index}`;
        return <section key={`${section.title}-${index}`} className="agent-response-section" role="region" aria-labelledby={headingId} style={{ '--section-index': index } as CSSProperties}>
          <div className="agent-response-section-heading"><h3 id={headingId}>{section.title}</h3></div>
          <div className={`agent-markdown${running && index === lastIndex ? ' streaming' : ''}`}>
            <StreamingMarkdown content={section.body} streaming={running && index === lastIndex} renderMarkdown={renderMarkdown} />
          </div>
        </section>;
      })}
    </div>
  </div>;
}
