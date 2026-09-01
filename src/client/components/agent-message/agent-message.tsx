import { useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownCode, MarkdownPre } from '../markdown/markdown-code.js';
import { hideWorkbenchControlBlocks, humanizeRunOutput, humanizeRunOutputBlocks } from '../../lib/run-output';
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
function useTypewriter(text: string, active: boolean, startAtBeginning = false, characterByCharacter = false): string {
  const [revealed, setRevealed] = useState(() => active && startAtBeginning ? 0 : text.length);
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
  const visibleLength = characterByCharacter
    ? revealed
    : Math.max(completedTokenLength(text, revealed), preservedPrefixLength);
  return text.slice(0, visibleLength);
}

function StreamingMarkdown({ content, streaming, startAtBeginning = false, characterByCharacter = false, renderMarkdown }: { content: string; streaming: boolean; startAtBeginning?: boolean; characterByCharacter?: boolean; renderMarkdown: (content: string) => ReactElement }) {
  const revealed = useTypewriter(content, streaming, startAtBeginning, characterByCharacter);
  return renderMarkdown(revealed);
}

function LiveActivityLine({ text, animate }: { text: string; animate: boolean }) {
  return <span>{useTypewriter(text, animate, animate)}</span>;
}

export function LiveRunOutput({ output, interjections = [] }: { output: string; interjections?: Array<{ id: string; body: string; pending: boolean; streamOffset?: number | null }> }) {
  const [visibleCount, setVisibleCount] = useState(LIVE_RUN_OUTPUT_PAGE_SIZE);
  const blocks = humanizeRunOutputBlocks(output);
  // Existing activity should be readable immediately when opening a running
  // conversation. Newly received blocks (or additions to the live block) are
  // the ones that animate, so streaming feels continuous without replaying
  // the whole backlog after every HTTPS fallback refetch.
  const knownBlocksRef = useRef(new Set<string>());
  const liveStreamInitializedRef = useRef(false);
  const isNewLiveBlock = (block: string) => liveStreamInitializedRef.current && !knownBlocksRef.current.has(block);
  useEffect(() => {
    blocks.forEach((block) => knownBlocksRef.current.add(block));
    liveStreamInitializedRef.current = true;
  }, [blocks]);
  // Pending interjections need a local boundary briefly. Accepted ones use the
  // server-captured boundary, which survives a conversation remount.
  const interjectionBoundariesRef = useRef(new Map<string, number>());
  for (const interjection of interjections) {
    if (interjection.streamOffset == null && !interjectionBoundariesRef.current.has(interjection.id)) {
      interjectionBoundariesRef.current.set(interjection.id, blocks.length);
    }
  }
  if (blocks.length === 0 && interjections.length === 0) {
    return <div className="live-run-output live-run-output-starting" aria-label="Live agent activity" aria-live="polite">
      <span className="visually-hidden">Agent is starting</span>
      <span className="live-run-output-skeleton" aria-hidden="true" />
    </div>;
  }
  const defaultHiddenCount = Math.max(0, blocks.length - visibleCount);
  // Do not page an interjection out of its own live timeline. Once one is
  // present, retain the activity from that boundary onward.
  const earliestInterjectionBoundary = interjections.reduce((earliest, interjection) => Math.min(
    earliest,
    interjection.streamOffset ?? interjectionBoundariesRef.current.get(interjection.id) ?? blocks.length,
  ), blocks.length);
  const hiddenCount = Math.min(defaultHiddenCount, earliestInterjectionBoundary);
  const visibleBlocks = blocks.slice(hiddenCount);
  const interjectionsAt = (boundary: number) => interjections.filter((interjection) => {
    const storedBoundary = interjection.streamOffset ?? interjectionBoundariesRef.current.get(interjection.id) ?? blocks.length;
    return boundary === visibleBlocks.length ? storedBoundary >= hiddenCount + visibleBlocks.length : storedBoundary === hiddenCount + boundary;
  });
  return (
    <div className="live-run-output" aria-label="Live agent activity">
      {hiddenCount > 0 && (
        <button type="button" className="show-more-activity-button" onClick={() => setVisibleCount((current) => current + LIVE_RUN_OUTPUT_PAGE_SIZE)}>
          Show earlier ({hiddenCount} more)
        </button>
      )}
      <ol aria-live="polite">
        {visibleBlocks.flatMap((block, index) => [
          // A block's text grows as network chunks arrive. Key it by its
          // append-only stream position so React preserves the typewriter's
          // reveal state instead of remounting and replaying the paragraph.
          <li key={`activity-${hiddenCount + index}`}><LiveActivityLine text={block.replace(/^●\s*/, '').replace(/^Decision:\s*/i, '')} animate={isNewLiveBlock(block)} /></li>,
          ...interjectionsAt(index + 1).map((interjection) => (
            <li key={interjection.id} className={`live-run-interjection${interjection.pending ? ' pending' : ''}`}>
              <span>{interjection.pending ? 'You interjected (sending)' : 'You interjected'}</span>
              <strong>{interjection.body}</strong>
            </li>
          )),
        ])}
        {visibleBlocks.length === 0 && interjectionsAt(0).map((interjection) => (
          <li key={interjection.id} className={`live-run-interjection${interjection.pending ? ' pending' : ''}`}>
            <span>{interjection.pending ? 'You interjected (sending)' : 'You interjected'}</span>
            <strong>{interjection.body}</strong>
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface AgentMessageInterjection { id: string; body: string; pending: boolean; streamOffset?: number | null }

// A completed reply that was steered mid-stream reads as one continuous
// answer even though Jeffrey's input landed partway through it. Splitting at
// the server-recorded block offsets turns that into the same before/after
// shape the live activity view already shows while the agent is running.
export function splitBodyAtInterjections(body: string, interjections: AgentMessageInterjection[]): Array<{ body: string; precedingInterjection: AgentMessageInterjection | null }> {
  const boundaries = interjections
    .filter((interjection): interjection is AgentMessageInterjection & { streamOffset: number } => interjection.streamOffset != null)
    .sort((a, b) => a.streamOffset - b.streamOffset);
  if (boundaries.length === 0) return [{ body, precedingInterjection: null }];
  const blocks = humanizeRunOutputBlocks(body);
  const segments: Array<{ body: string; precedingInterjection: AgentMessageInterjection | null }> = [];
  let cursor = 0;
  boundaries.forEach((interjection, index) => {
    const offset = Math.max(cursor, Math.min(interjection.streamOffset, blocks.length));
    segments.push({ body: blocks.slice(cursor, offset).join('\n\n'), precedingInterjection: index === 0 ? null : boundaries[index - 1] });
    cursor = offset;
  });
  segments.push({ body: blocks.slice(cursor).join('\n\n'), precedingInterjection: boundaries[boundaries.length - 1] });
  return segments.filter((segment) => segment.body.length > 0);
}

export function AgentMessageBody({ body, running, conversationId, workItemId, interjections, detailForSingle = false, typewriteOnCompletion = false, hasStreamed = false }: { body: string; running: boolean; conversationId?: string; workItemId?: string; interjections?: Array<{ id: string; body: string; pending: boolean; streamOffset?: number | null }>; detailForSingle?: boolean; typewriteOnCompletion?: boolean; hasStreamed?: boolean }) {
  const sectionIdPrefix = useId();
  const wasRunning = useRef(running);
  // A caller-supplied "has this message ever streamed" flag survives
  // remounts (e.g. Codex+Claude row pairing changing this component's React
  // key) that would otherwise reset the local wasRunning ref and silently
  // skip the completion typewriter.
  const shouldTypewriteCompletion = typewriteOnCompletion && (wasRunning.current || hasStreamed) && !running;
  useEffect(() => { wasRunning.current = running; }, [running]);
  const humanized = running ? humanizeRunOutput(body) : body;
  const visibleBody = hideWorkbenchControlBlocks(humanized);
  if (!visibleBody && !running && !interjections?.length) return null;
  // Progress is operational context, not an authored reply. Keep its compact
  // activity feed distinct from the section-card treatment for final answers.
  if (running) return <LiveRunOutput output={visibleBody} interjections={interjections} />;
  const sections = splitAgentResponse(visibleBody);
  const structured = sections.length > 1 || detailForSingle;
  const renderMarkdown = (content: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    code: MarkdownCode,
    pre: MarkdownPre,
    a: ({ href = '', children, ...props }) => {
      const external = /^(?:(?!file:)[a-z][a-z0-9+.-]*:|#)/i.test(href);
      const artifactHref = external ? href : `/api/artifacts/open?path=${encodeURIComponent(href)}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ''}${workItemId ? `&workItemId=${encodeURIComponent(workItemId)}` : ''}`;
      return <a {...props} href={artifactHref} target="_blank" rel="noreferrer">{children}</a>;
    },
  }}>{content}</ReactMarkdown>;

  if (!structured) return <div className="agent-markdown"><StreamingMarkdown content={visibleBody} streaming={shouldTypewriteCompletion} startAtBeginning={shouldTypewriteCompletion} characterByCharacter={shouldTypewriteCompletion} renderMarkdown={renderMarkdown} /></div>;

  const detailSections = sections.length === 1 && detailForSingle ? [{ title: 'Detail', body: visibleBody }] : sections;
  const lastIndex = detailSections.length - 1;
  return <div className="agent-response" role="group" aria-label={`Agent response in ${detailSections.length} part${detailSections.length === 1 ? '' : 's'}`}>
    <div className="agent-response-deck">
      {detailSections.map((section, index) => {
        const headingId = `${sectionIdPrefix}-${index}`;
        return <section key={`${section.title}-${index}`} className="agent-response-section" role="region" aria-labelledby={headingId} style={{ '--section-index': index } as CSSProperties}>
          <div className="agent-response-section-heading"><h3 id={headingId}>{section.title}</h3></div>
          <div className={`agent-markdown${running && index === lastIndex ? ' streaming' : ''}`}>
            <StreamingMarkdown content={section.body} streaming={(running && index === lastIndex) || shouldTypewriteCompletion} startAtBeginning={shouldTypewriteCompletion} characterByCharacter={shouldTypewriteCompletion} renderMarkdown={renderMarkdown} />
          </div>
        </section>;
      })}
    </div>
  </div>;
}
