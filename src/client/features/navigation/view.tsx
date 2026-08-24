import { Cloud, Command, MessageCircle, MoreHorizontal, Wrench } from 'lucide-react';
import type { MouseEvent } from 'react';
import { ArtifactNav } from '../../artifacts';
import { DiscoveryNav } from '../../discovery';
import { InsightsNav } from '../../insights';

export type NavigationViewName = 'active' | 'workbench' | 'archive' | 'artifacts' | 'context' | 'discovery' | 'insights';

export function NavigationView({ view, mobileNavOpen, isCompactNav, counts, conversationCount, onOpenActive, onOpenWorkbench, onOpenDiscovery, onOpenConversations, onOpenArtifacts, onOpenInsights, onOpenSources, onToggleMore }: {
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
}) {
  const releasePointerFocus = (event: MouseEvent<HTMLElement>) => {
    // Pointer navigation should not leave the rail expanded; keyboard focus must.
    if (event.detail > 0) (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.blur();
  };
  return <aside id="primary-nav" className="sidebar">
    <div className="brand"><span className="brand-mark">W</span><span>Workbench</span></div>
    <nav onClick={releasePointerFocus}>
      <button className={`nav-item ${view === 'active' ? 'active' : ''}`} onClick={onOpenActive}><Command size={16} /> Attention stack <span>{counts?.active ?? '…'}</span></button>
      <button className={`nav-item ${view === 'workbench' ? 'active' : ''}`} onClick={onOpenWorkbench}><Wrench size={16} /> Workbench <span>{counts?.workbench ?? '…'}</span></button>
      <DiscoveryNav active={view === 'discovery'} onClick={onOpenDiscovery} />
      <button className={`nav-item ${view === 'context' ? 'active' : ''}`} onClick={onOpenConversations}><MessageCircle size={16} /> Conversations <span>{conversationCount ?? '…'}</span></button>
      <div id="mobile-nav-more" className="mobile-nav-secondary" aria-label="More destinations">
        <ArtifactNav active={view === 'artifacts'} onClick={onOpenArtifacts} />
        <InsightsNav active={view === 'insights'} onClick={onOpenInsights} />
        <button className="nav-item" onClick={onOpenSources}><Cloud size={16} /> Sources</button>
      </div>
      {isCompactNav && <button className={`nav-item mobile-nav-more ${mobileNavOpen || ['artifacts', 'insights'].includes(view) ? 'active' : ''}`} aria-controls="mobile-nav-more" aria-expanded={mobileNavOpen} onClick={onToggleMore}><MoreHorizontal size={18} /> More</button>}
    </nav>
  </aside>;
}
