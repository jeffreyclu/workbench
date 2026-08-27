import { Cloud, Command, MessageCircle, MoreHorizontal, Search, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import type { MemorySearchResult } from '../../../shared/contracts';
import { ArtifactNav } from '../artifacts/view';
import { DiscoveryNav } from '../discovery';
import { InsightsNav } from '../insights/view';
import { memorySourceLabel } from '../../lib/formatters';
import { api } from '../../data/api';
import { Skeleton, SkeletonText } from '../../components/skeleton/skeleton';
import { useValuePulse } from '../../hooks/use-value-pulse';
import { useDebouncedValue } from '../conversation/hooks';

export type NavigationViewName = 'active' | 'workbench' | 'archive' | 'artifacts' | 'context' | 'discovery' | 'insights';

const GLOBAL_SEARCH_RESULT_LIMIT = 20;
const GLOBAL_SEARCH_MAX_RESULTS = 100;

export function GlobalSearch({ onSelectResult }: { onSelectResult: (result: MemorySearchResult) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [resultLimit, setResultLimit] = useState(GLOBAL_SEARCH_RESULT_LIMIT);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useQuery({
    queryKey: ['global-memory-search', debouncedQuery, resultLimit],
    queryFn: () => api.searchMemory(debouncedQuery, resultLimit),
    enabled: open && debouncedQuery.length > 0,
  });
  const visibleResults = results.data?.results ?? [];
  const selectableResults = visibleResults.filter((result) => Boolean(result.conversationId || result.workItemId));
  useEffect(() => {
    setActiveResultIndex(-1);
    setResultLimit(GLOBAL_SEARCH_RESULT_LIMIT);
  }, [debouncedQuery]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  function closeOverlay() {
    setQuery('');
    setOpen(false);
    setActiveResultIndex(-1);
  }
  function selectResult(result: MemorySearchResult) {
    onSelectResult(result);
    closeOverlay();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      closeOverlay();
      return;
    }
    if (event.key === 'Enter' && activeResultIndex >= 0) {
      event.preventDefault();
      selectResult(selectableResults[activeResultIndex]);
      return;
    }
    if (!selectableResults.length || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    setActiveResultIndex((current) => event.key === 'ArrowDown'
      ? Math.min(current + 1, selectableResults.length - 1)
      : Math.max(current === -1 ? selectableResults.length - 1 : current - 1, 0));
  }
  return <div className="global-search">
    <button type="button" className="icon-button global-search-trigger" aria-label="Search everything" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <Search size={15} />
    </button>
    {open && createPortal(
      <div
        className="global-search-overlay"
        role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget) closeOverlay(); }}
      >
        <div className="global-search-panel" role="dialog" aria-modal="true" aria-label="Search everything">
          <div className="search-box">
            <Search size={15} />
            <input
              ref={inputRef}
              aria-label="Search everything"
              aria-autocomplete="list"
              aria-controls="global-search-results"
              aria-activedescendant={activeResultIndex >= 0 ? `global-search-result-${activeResultIndex}` : undefined}
              aria-expanded={Boolean(debouncedQuery)}
              role="combobox"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActiveResultIndex(-1); }}
              onKeyDown={handleKeyDown}
              placeholder="Search everything…"
            />
            {query && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}
            <button type="button" className="icon-button" aria-label="Close search" onClick={closeOverlay}><X size={13} /></button>
          </div>
          {debouncedQuery && (
            <div id="global-search-results" className="global-search-results" role="listbox">
              {results.isLoading && <GlobalSearchResultSkeleton />}
              {results.isError && <div className="page-state error-message">Search failed. <button className="button secondary compact" onClick={() => results.refetch()}>Retry</button></div>}
              {!results.isLoading && !results.isError && visibleResults.length === 0 && (
                <div className="page-state">No matches for “{debouncedQuery}”.</div>
              )}
              {visibleResults.map((result) => {
                const canOpen = Boolean(result.conversationId || result.workItemId);
                const selectableIndex = selectableResults.indexOf(result);
                const Tag = canOpen ? 'button' : 'div';
                return <Tag
                  key={`${result.source}-${result.sourceId}`}
                  id={canOpen ? `global-search-result-${selectableIndex}` : undefined}
                  className="global-search-result"
                  aria-selected={canOpen ? selectableIndex === activeResultIndex : undefined}
                  role={canOpen ? 'option' : undefined}
                  onClick={canOpen ? () => selectResult(result) : undefined}
                >
                  <span className="global-search-result-meta">
                    <span className="global-search-result-source">{memorySourceLabel(result.source)}</span>
                    {!canOpen && <span className="global-search-result-preview">Preview only</span>}
                  </span>
                  <strong>{result.title || 'Untitled'}</strong>
                  <small>{result.snippet}</small>
                </Tag>;
              })}
              {!results.isLoading && !results.isError && visibleResults.length > 0 && <div className="global-search-more-hint">
                <span>Showing {visibleResults.length} result{visibleResults.length === 1 ? '' : 's'}.</span>
                {results.data?.hasMore && resultLimit < GLOBAL_SEARCH_MAX_RESULTS && <button type="button" className="button secondary compact" onClick={() => setResultLimit((limit) => Math.min(limit + GLOBAL_SEARCH_RESULT_LIMIT, GLOBAL_SEARCH_MAX_RESULTS))}>Show 20 more</button>}
                {results.data?.hasMore && resultLimit === GLOBAL_SEARCH_MAX_RESULTS && <span>More matches may exist. Refine your search to narrow them.</span>}
                {!results.data?.hasMore && <span>All ranked matches shown.</span>}
              </div>}
            </div>
          )}
        </div>
      </div>,
      document.body,
    )}
  </div>;
}

export function PromotionQueueStatus() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const status = useQuery({
    queryKey: ['promotion-queue-status'],
    queryFn: () => api.getPromotionQueueStatus(),
    refetchInterval: 2_000,
  });
  const data = status.data;

  let color: 'green' | 'blue' | 'red' | 'idle' = 'idle';
  if (data?.running) color = 'blue';
  else if (data && data.queueLength > 0) color = 'blue';
  else if (data?.lastBuild?.status === 'failed') color = 'red';
  else if (data?.lastBuild?.status === 'succeeded') color = 'green';

  function updateAnchor() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 8, left: rect.left });
  }
  function show() {
    updateAnchor();
    setOpen(true);
  }

  return <div
    className="promotion-status-wrap"
    onMouseEnter={show}
    onMouseLeave={() => setOpen(false)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
  >
    <button
      ref={buttonRef}
      type="button"
      className={`brand-mark brand-mark-${color}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="Promotion status"
      onClick={() => (open ? setOpen(false) : show())}
      onFocus={show}
    >W</button>
    {open && data && anchor && createPortal(
      <div className="promotion-status-popover" role="dialog" aria-label="Promotion status" style={{ top: anchor.top, left: anchor.left }}>
        <div className="promotion-status-popover-row">
          <strong>Queue</strong>
          <span>{data.queueLength > 0 ? `${data.queueLength} waiting${data.oldestQueuedAt ? ` since ${new Date(data.oldestQueuedAt).toLocaleTimeString()}` : ''}` : 'Empty'}</span>
        </div>
        <div className="promotion-status-popover-row">
          <strong>Running</strong>
          <span>{data.running ? `${data.running.progress} (started ${new Date(data.running.startedAt).toLocaleTimeString()})` : 'None'}</span>
        </div>
        <div className="promotion-status-popover-row">
          <strong>Last build</strong>
          <span>{data.lastBuild ? `${data.lastBuild.status} at ${new Date(data.lastBuild.at).toLocaleTimeString()} — ${data.lastBuild.summary}` : 'No builds yet'}</span>
        </div>
      </div>,
      document.body,
    )}
  </div>;
}

function GlobalSearchResultSkeleton() {
  return <div className="global-search-skeleton" aria-hidden="true">
    {Array.from({ length: 3 }, (_, index) => (
      <div className="global-search-result" key={index}>
        <Skeleton width="64px" height="0.7em" />
        <Skeleton width={index === 2 ? '54%' : '76%'} height="0.9em" />
        <SkeletonText lines={2} />
      </div>
    ))}
  </div>;
}

export function NavigationView({ view, mobileNavOpen, isCompactNav, counts, conversationCount, onOpenActive, onOpenWorkbench, onOpenDiscovery, onOpenConversations, onOpenArtifacts, onOpenInsights, onOpenSources, onToggleMore, onSelectGlobalSearchResult }: {
  view: NavigationViewName;
  mobileNavOpen: boolean;
  isCompactNav: boolean;
  counts: { active?: number; workbench?: number; archive?: number } | undefined;
  conversationCount: number | undefined;
  onOpenActive: () => void;
  onOpenWorkbench: () => void;
  onOpenDiscovery: () => void;
  onOpenConversations: () => void;
  onOpenArtifacts: () => void;
  onOpenInsights: () => void;
  onOpenSources: () => void;
  onToggleMore: () => void;
  onSelectGlobalSearchResult: (result: MemorySearchResult) => void;
}) {
  const releasePointerFocus = (event: MouseEvent<HTMLElement>) => {
    // Pointer navigation should not leave the rail expanded; keyboard focus must.
    if (event.detail > 0) (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.blur();
  };
  const activePulse = useValuePulse(counts?.active);
  const workbenchPulse = useValuePulse(counts?.workbench);
  const conversationPulse = useValuePulse(conversationCount);
  return <aside id="primary-nav" className="sidebar">
    <div className="brand"><PromotionQueueStatus /><span>Workbench</span></div>
    <nav onClick={releasePointerFocus}>
      <button className={`nav-item ${view === 'active' ? 'active' : ''}`} onClick={onOpenActive}><Command size={16} /> Attention stack <span className={activePulse}>{counts?.active ?? '…'}</span></button>
      <button className={`nav-item ${view === 'workbench' ? 'active' : ''}`} onClick={onOpenWorkbench}><Wrench size={16} /> Workbench <span className={workbenchPulse}>{counts?.workbench ?? '…'}</span></button>
      <DiscoveryNav active={view === 'discovery'} onClick={onOpenDiscovery} />
      <button className={`nav-item mobile-conversation-nav ${view === 'context' ? 'active' : ''}`} onClick={onOpenConversations}><MessageCircle size={16} /> Conversations <span className={conversationPulse}>{conversationCount ?? '…'}</span></button>
      <div id="mobile-nav-more" className="mobile-nav-secondary" aria-label="More destinations">
        <div className="mobile-global-search"><GlobalSearch onSelectResult={onSelectGlobalSearchResult} /></div>
        <ArtifactNav active={view === 'artifacts'} onClick={onOpenArtifacts} />
        <InsightsNav active={view === 'insights'} onClick={onOpenInsights} />
        <button className="nav-item" onClick={onOpenSources}><Cloud size={16} /> Sources</button>
      </div>
      {isCompactNav && <button className={`nav-item mobile-nav-more ${mobileNavOpen || ['artifacts', 'insights'].includes(view) ? 'active' : ''}`} aria-controls="mobile-nav-more" aria-expanded={mobileNavOpen} onClick={onToggleMore}><MoreHorizontal size={18} /> More</button>}
    </nav>
    <div className="sidebar-footer">
      <GlobalSearch onSelectResult={onSelectGlobalSearchResult} />
    </div>
  </aside>;
}
