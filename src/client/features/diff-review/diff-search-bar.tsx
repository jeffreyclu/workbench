import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import type { ReviewDecision } from './logic.js';
import { buildDiffSearchIndex, searchDiffIndex, stepMatchIndex, type DiffSearchMatch } from './diff-search.js';

/** Find-in-diff for the whole changeset. The browser's own find cannot do this:
 * the diff shows one decision's files at a time, so text in every other file is
 * not in the page. This searches the patches themselves and, on a result,
 * hands the match back so the surface can select the change and land on the
 * line. */
export const DiffReviewSearch = memo(function DiffReviewSearch({ files, decisions, onJump, onClose }: {
  files: Pick<WorkspaceDiffFile, 'path' | 'patch' | 'isBinary'>[];
  decisions: ReviewDecision[];
  onJump: (match: DiffSearchMatch) => void;
  /** Fired when the bar closes or the query is emptied, so the surface can drop
   * the highlight it drew for the last result. */
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement | null>(null);
  const index = useMemo(() => buildDiffSearchIndex(files, decisions), [files, decisions]);
  // Typing stays responsive on a large changeset: the scan trails the input.
  const deferredQuery = useDeferredValue(query);
  const { matches, truncated } = useMemo(() => searchDiffIndex(index, deferredQuery), [index, deferredQuery]);
  // -1 until the reviewer visits a result, so the first Enter lands on the first match.
  const activeIndex = Math.min(active, matches.length - 1);
  const current = matches[activeIndex] ?? null;

  useEffect(() => {
    // Takes over the browser's find while the review is on screen, because the
    // browser would search only the one decision's files that happen to be drawn.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setOpen(true);
      input.current?.focus();
      input.current?.select();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setActive(-1);
    onClose();
  };
  const jumpTo = (next: number) => {
    const match = matches[next];
    if (!match) return;
    setActive(next);
    onJump(match);
  };
  const step = (direction: 1 | -1) => jumpTo(stepMatchIndex(activeIndex, matches.length, direction));

  if (!open) {
    return <button type="button" className="diff-review-search-toggle" aria-keyshortcuts="Control+F Meta+F" title="Find in diff (⌘F)" onClick={() => setOpen(true)}><Search size={13} aria-hidden="true" />Find in diff</button>;
  }
  return <section className="diff-review-search" role="search" aria-label="Find in diff">
    <div className="diff-review-search-bar">
      <Search size={14} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        aria-label="Find in diff"
        placeholder="Find in every changed file"
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => { setQuery(event.target.value); setActive(-1); if (!event.target.value.trim()) onClose(); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          else if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
        }}
      />
      <span className="diff-review-search-count" role="status">
        {!deferredQuery.trim() ? '' : matches.length === 0 ? 'No matches' : activeIndex < 0 ? `${matches.length}${truncated ? '+' : ''} ${matches.length === 1 ? 'match' : 'matches'}` : `${activeIndex + 1} of ${matches.length}${truncated ? '+' : ''}`}
      </span>
      <button type="button" aria-label="Previous match" disabled={matches.length === 0} onClick={() => step(-1)}><ChevronUp size={15} aria-hidden="true" /></button>
      <button type="button" aria-label="Next match" disabled={matches.length === 0} onClick={() => step(1)}><ChevronDown size={15} aria-hidden="true" /></button>
      <button type="button" aria-label="Close find in diff" onClick={close}><X size={15} aria-hidden="true" /></button>
    </div>
    {matches.length > 0 && <>
      <ul className="diff-review-search-results" aria-label="Matching lines">
        {matches.map((match, position) => <li key={match.id}>
          <button type="button" aria-current={match === current ? 'true' : undefined} className={`diff-review-search-result kind-${match.kind}`} onClick={() => jumpTo(position)}>
            <span className="diff-review-search-result-file">{match.filePath}{match.lineNumber === null ? '' : `:${match.lineNumber}`}</span>
            <code>{match.text.slice(0, match.start)}<mark>{match.text.slice(match.start, match.start + deferredQuery.trim().length)}</mark>{match.text.slice(match.start + deferredQuery.trim().length)}</code>
          </button>
        </li>)}
      </ul>
      {truncated && <p className="muted diff-review-search-truncated">Showing the first {matches.length} matching lines. Narrow the search to see the rest.</p>}
    </>}
  </section>;
});
