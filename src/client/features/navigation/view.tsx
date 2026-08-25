import { Cloud, Command, MessageCircle, MoreHorizontal, Search, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MemorySearchResult } from '../../../shared/contracts';
import { ArtifactNav } from '../../artifacts';
import { DiscoveryNav } from '../../discovery';
import { InsightsNav } from '../../insights';
import { memorySourceLabel } from '../../formatters';
import { api } from '../../api';
import { Skeleton, SkeletonText } from '../../skeleton';
import { useValuePulse } from '../../use-value-pulse';
import { useDebouncedValue } from '../conversation/hooks';

export type NavigationViewName = 'active' | 'workbench' | 'archive' | 'artifacts' | 'context' | 'discovery' | 'insights';

export function GlobalSearch({ onSelectResult }: { onSelectResult: (result: MemorySearchResult) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const containerRef = useRef<HTMLDivElement>(null);
  const results = useQuery({
    queryKey: ['global-memory-search', debouncedQuery],
    queryFn: () => api.searchMemory(debouncedQuery, 20),
    enabled: debouncedQuery.length > 0,
  });
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);
  const selectableResults = results.data?.results.filter((result) => Boolean(result.conversationId || result.workItemId)) ?? [];
  useEffect(() => {
    setActiveResultIndex(-1);
  }, [debouncedQuery, results.data]);
  function selectResult(result: MemorySearchResult) {
    onSelectResult(result);
    setQuery('');
    setOpen(false);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setQuery('');
      setOpen(false);
      setActiveResultIndex(-1);
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
  return <div className="global-search" ref={containerRef}>
    <div className="search-box">
      <Search size={15} />
      <input
        aria-label="Search everything"
        aria-autocomplete="list"
        aria-controls="global-search-results"
        aria-activedescendant={activeResultIndex >= 0 ? `global-search-result-${activeResultIndex}` : undefined}
        aria-expanded={open && Boolean(debouncedQuery)}
        role="combobox"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setActiveResultIndex(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Search everything…"
      />
      {query && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}
    </div>
    {open && debouncedQuery && (
      <div id="global-search-results" className="global-search-results" role="listbox">
        {results.isLoading && <GlobalSearchResultSkeleton />}
        {results.isError && <div className="page-state error-message">Search failed. <button className="button secondary compact" onClick={() => results.refetch()}>Retry</button></div>}
        {!results.isLoading && !results.isError && (results.data?.results.length ?? 0) === 0 && (
          <div className="page-state">No matches for “{debouncedQuery}”.</div>
        )}
        {results.data?.results.map((result) => {
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
      </div>
    )}
  </div>;
}

export function PromotionQueueStatus() {
  const [open, setOpen] = useState(false);
  const status = useQuery({
    queryKey: ['promotion-queue-status'],
    queryFn: () => api.getPromotionQueueStatus(),
    refetchInterval: 2_000,
  });
  const data = status.data;
  if (!data) return null;

  let color: 'green' | 'blue' | 'red' | null = null;
  if (data.running) color = 'blue';
  else if (data.queueLength > 0) color = 'blue';
  else if (data.lastBuild?.status === 'failed') color = 'red';
  else if (data.lastBuild?.status === 'succeeded') color = 'green';
  if (!color) return null;

  return <div
    className="promotion-status-wrap"
    onMouseEnter={() => setOpen(true)}
    onMouseLeave={() => setOpen(false)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
  >
    <button
      type="button"
      className={`promotion-status-led promotion-status-led-${color}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="Promotion status"
      onClick={() => setOpen((current) => !current)}
      onFocus={() => setOpen(true)}
    />
    {open && <div className="promotion-status-popover" role="dialog" aria-label="Promotion status">
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
    </div>}
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
    <div className="brand"><span className="brand-mark">W</span><span>Workbench</span><PromotionQueueStatus /></div>
    <nav onClick={releasePointerFocus}>
      <button className={`nav-item ${view === 'active' ? 'active' : ''}`} onClick={onOpenActive}><Command size={16} /> Attention stack <span className={activePulse}>{counts?.active ?? '…'}</span></button>
      <button className={`nav-item ${view === 'workbench' ? 'active' : ''}`} onClick={onOpenWorkbench}><Wrench size={16} /> Workbench <span className={workbenchPulse}>{counts?.workbench ?? '…'}</span></button>
      <DiscoveryNav active={view === 'discovery'} onClick={onOpenDiscovery} />
      <button className={`nav-item ${view === 'context' ? 'active' : ''}`} onClick={onOpenConversations}><MessageCircle size={16} /> Conversations <span className={conversationPulse}>{conversationCount ?? '…'}</span></button>
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
