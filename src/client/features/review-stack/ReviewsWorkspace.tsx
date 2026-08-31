import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ProjectColorDot } from '../../components/project/project-color';
import type { SharedConversation } from '../../../shared/contracts';
import { conversationData, conversationQueryKeys } from '../conversation/data';
import { pullRequestUrls, pullRequestUrlsInText } from '../github-diff/logic.js';
import { ReviewStackView } from './ReviewStackView';

/**
 * Reviews are a third consumer of the stack rail, alongside tasks and
 * conversations — not a pane inside the conversation view. The rail picks
 * *which* review you are in; the branch/worktree/pull-request selector inside
 * the canvas switches sources within it. Clicking a card opens the canvas.
 */
export function ReviewsWorkspace() {
  const [selected, setSelected] = useState<SharedConversation | null>(null);
  const conversations = useInfiniteQuery({
    queryKey: conversationQueryKeys.rail('active'),
    queryFn: ({ pageParam }) => conversationData.list('active', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5_000,
  });
  const reviewTargets = useMemo(() => conversations.data?.pages.flatMap((page) => page.conversations) ?? [], [conversations.data?.pages]);

  // A pasted pull-request link is enough to review it, so pull-request sources
  // are recovered from the review's own thread. Keyed separately from the
  // conversation view's message cache: this is a one-shot read, not its
  // paginated thread.
  const threadForSources = useQuery({
    queryKey: ['review-source-candidates', selected?.id ?? null],
    queryFn: () => conversationData.listMessages(selected!.id),
    enabled: Boolean(selected),
  });
  const pullRequestUrlCandidates = useMemo(
    () => pullRequestUrls((threadForSources.data?.messages ?? []).flatMap((message) => pullRequestUrlsInText(message.body))),
    [threadForSources.data?.messages],
  );

  return (
    <main className={`shared-workspace review-workspace ${selected ? '' : 'stack-only'}`}>
      <aside id="review-rail" className="conversation-rail" aria-label="Reviews">
        <header className="stack-toolbar"><div className="stack-toolbar-copy"><span className="eyebrow">Reviews</span><h2>Reviews</h2></div></header>
        <div className="conversation-tabs review-target-list">
          {conversations.isLoading && <div className="page-state">Loading reviews…</div>}
          {conversations.isError && <div className="page-state error-message">Could not load reviews. <button type="button" className="button secondary compact" onClick={() => void conversations.refetch()}>Retry</button></div>}
          {!conversations.isLoading && !conversations.isError && reviewTargets.length === 0 && <div className="page-state">No reviews yet.</div>}
          {reviewTargets.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`stack-card review-target-card ${selected?.id === conversation.id ? 'active' : ''} ${conversation.linkedProjectName ? 'project-colored' : ''}`}
              onClick={() => setSelected(conversation)}
            >
              <span className="conversation-tab-title">
                {conversation.linkedProjectName && <ProjectColorDot projectName={conversation.linkedProjectName} labelled />}
                <strong>{conversation.title || 'Untitled review'}</strong>
              </span>
              <small className="conversation-tab-meta"><span>{new Date(conversation.updatedAt).toLocaleDateString()}</span></small>
            </button>
          ))}
        </div>
      </aside>
      <section className="agent-console" aria-label="Review canvas">
        <header className="agent-console-header">
          <div className="agent-console-title"><span className="eyebrow">Review</span><h2>{selected?.title || 'Reviews'}</h2></div>
          {selected && <div className="conversation-window-actions"><button type="button" className="icon-button" aria-label="Back to reviews" title="Back to reviews" onClick={() => setSelected(null)}><ArrowLeft size={16} /></button></div>}
        </header>
        {selected
          ? <div className="conversation-review" aria-label="Review canvas"><ReviewStackView key={selected.id} scope={{ conversationId: selected.id }} pullRequestUrlCandidates={pullRequestUrlCandidates} /></div>
          : <div className="page-state">Pick a review from the stack.</div>}
      </section>
    </main>
  );
}
