import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ProjectColorDot } from '../../components/project/project-color';
import type { SharedConversation, StandaloneReview } from '../../../shared/contracts';
import { sourceClient } from '../../data/source-client';
import { conversationData, conversationQueryKeys } from '../conversation/data';
import { pullRequestUrls, pullRequestUrlsInText } from '../github-diff/logic.js';
import { standaloneReviewQueryKeys } from './data';
import { NewReviewModal } from './new-review-modal';
import { ReviewStackView } from './ReviewStackView';

/** What the canvas is currently reading. A review created from a link or a
 * repository stands on its own; a conversation is still openable, but it is
 * one way in rather than the way in. */
type Selection =
  | { kind: 'review'; review: StandaloneReview }
  | { kind: 'conversation'; conversation: SharedConversation };

function reviewSubtitle(review: StandaloneReview): string {
  if (review.source.kind === 'pull-request') return 'Pull request';
  const repository = review.source.repositoryPath.split('/').filter(Boolean).pop() ?? review.source.repositoryPath;
  const ref = review.source.ref?.replace(/^branch:/, '').replace(/^worktree:.*\//, '');
  return ref ? `${repository} · ${ref}` : repository;
}

/**
 * Reviews are a third consumer of the stack rail, alongside tasks and
 * conversations — not a pane inside the conversation view. The rail picks
 * *which* review you are in; the branch/worktree/pull-request selector inside
 * the canvas switches sources within it. Clicking a card opens the canvas.
 *
 * A review is started from "New review": a pull request link or a repository
 * and branch. A conversation is no longer a precondition for reviewing
 * anything — conversations that carry a diff are listed underneath, because
 * they are still reviewable, not because a review needs one.
 */
export function ReviewsWorkspace() {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();

  const reviews = useQuery({
    queryKey: standaloneReviewQueryKeys.list,
    queryFn: () => sourceClient.listStandaloneReviews(),
  });
  const conversations = useInfiniteQuery({
    queryKey: conversationQueryKeys.rail('active'),
    queryFn: ({ pageParam }) => conversationData.list('active', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5_000,
  });
  const reviewTargets = useMemo(() => conversations.data?.pages.flatMap((page) => page.conversations) ?? [], [conversations.data?.pages]);
  const standaloneReviews = reviews.data?.reviews ?? [];

  const selectedConversationId = selected?.kind === 'conversation' ? selected.conversation.id : null;
  // A pasted pull-request link is enough to review it, so pull-request sources
  // are recovered from the review's own thread. Keyed separately from the
  // conversation view's message cache: this is a one-shot read, not its
  // paginated thread.
  const threadForSources = useQuery({
    queryKey: ['review-source-candidates', selectedConversationId],
    queryFn: () => conversationData.listMessages(selectedConversationId!),
    enabled: Boolean(selectedConversationId),
  });
  const conversationPullRequestUrls = useMemo(
    () => pullRequestUrls((threadForSources.data?.messages ?? []).flatMap((message) => pullRequestUrlsInText(message.body))),
    [threadForSources.data?.messages],
  );
  // A standalone review's pull request is its own record, not something to go
  // looking for in a thread it does not have.
  const pullRequestUrlCandidates = selected?.kind === 'review'
    ? (selected.review.source.kind === 'pull-request' ? [selected.review.source.url] : [])
    : conversationPullRequestUrls;

  const deleteReview = async (review: StandaloneReview) => {
    await sourceClient.deleteStandaloneReview(review.id);
    if (selected?.kind === 'review' && selected.review.id === review.id) setSelected(null);
    await queryClient.invalidateQueries({ queryKey: standaloneReviewQueryKeys.list });
  };

  const title = selected?.kind === 'review' ? selected.review.title : selected?.conversation.title;

  return (
    <main className={`shared-workspace review-workspace ${selected ? '' : 'stack-only'}`}>
      <aside id="review-rail" className="conversation-rail" aria-label="Reviews">
        <header className="stack-toolbar">
          <div className="stack-toolbar-copy"><span className="eyebrow">Reviews</span><h2>Reviews</h2></div>
          <button type="button" className="button compact" onClick={() => setCreating(true)}><Plus size={14} /> New review</button>
        </header>
        <div className="conversation-tabs review-target-list">
          {reviews.isError && <div className="page-state error-message">Could not load reviews. <button type="button" className="button secondary compact" onClick={() => void reviews.refetch()}>Retry</button></div>}
          {!reviews.isLoading && standaloneReviews.length === 0 && <div className="page-state">No reviews yet. Start one from a pull request link or a repository.</div>}
          {standaloneReviews.map((review) => (
            <div key={review.id} className={`stack-card review-target-card standalone-review-card ${selected?.kind === 'review' && selected.review.id === review.id ? 'active' : ''}`}>
              <button type="button" className="review-target-open" onClick={() => setSelected({ kind: 'review', review })}>
                <span className="conversation-tab-title"><strong>{review.title}</strong></span>
                <small className="conversation-tab-meta"><span>{reviewSubtitle(review)}</span><span>{new Date(review.updatedAt).toLocaleDateString()}</span></small>
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${review.title}`} title="Delete review" onClick={() => void deleteReview(review)}><Trash2 size={14} /></button>
            </div>
          ))}

          <div className="rail-section-heading"><span className="eyebrow">From conversations</span></div>
          {conversations.isLoading && <div className="page-state">Loading conversations…</div>}
          {conversations.isError && <div className="page-state error-message">Could not load conversations. <button type="button" className="button secondary compact" onClick={() => void conversations.refetch()}>Retry</button></div>}
          {reviewTargets.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`stack-card review-target-card ${selectedConversationId === conversation.id ? 'active' : ''} ${conversation.linkedProjectName ? 'project-colored' : ''}`}
              onClick={() => setSelected({ kind: 'conversation', conversation })}
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
          <div className="agent-console-title"><span className="eyebrow">Review</span><h2>{title || 'Reviews'}</h2></div>
          {selected && <div className="conversation-window-actions"><button type="button" className="icon-button" aria-label="Back to reviews" title="Back to reviews" onClick={() => setSelected(null)}><ArrowLeft size={16} /></button></div>}
        </header>
        {selected
          ? <div className="conversation-review" aria-label="Review canvas">
              <ReviewStackView
                key={selected.kind === 'review' ? selected.review.id : selected.conversation.id}
                scope={selected.kind === 'review' ? { reviewId: selected.review.id } : { conversationId: selected.conversation.id }}
                pullRequestUrlCandidates={pullRequestUrlCandidates}
              />
            </div>
          : <div className="page-state">Pick a review from the stack, or start a new one.</div>}
      </section>
      {creating && <NewReviewModal onClose={() => setCreating(false)} onCreated={(review) => { setCreating(false); setSelected({ kind: 'review', review }); }} />}
    </main>
  );
}
