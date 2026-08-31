import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { StandaloneReview } from '../../../shared/contracts';
import { sourceClient } from '../../data/source-client';
import { writeReviewStackSource } from '../../lib/preferences';
import { ModalDialog } from '../../components/dialogs/modal-dialog';
import { pullRequestUrls } from '../github-diff/logic.js';
import { standaloneReviewQueryKeys } from './data.js';
import { branchSourceId, worktreeSourceId } from './source.js';

type ReviewKind = 'pull-request' | 'repository';

/**
 * Starting a review needs one thing: what to read. A pull request link is
 * enough, and so is a repository plus the branch to open on — neither requires
 * a conversation to have happened first, which is what this replaces.
 */
export function NewReviewModal({ onClose, onCreated }: { onClose: () => void; onCreated: (review: StandaloneReview) => void }) {
  const [kind, setKind] = useState<ReviewKind>('pull-request');
  const [pullRequestUrl, setPullRequestUrl] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [ref, setRef] = useState('');
  const [title, setTitle] = useState('');
  const queryClient = useQueryClient();

  const repositories = useQuery({
    queryKey: ['review-repositories'],
    queryFn: () => sourceClient.listReviewRepositories(),
  });
  // Branches are only asked for once a repository is chosen: there is no
  // repository-independent answer to "which branch".
  const refs = useQuery({
    queryKey: ['review-repository-refs', repositoryPath],
    queryFn: () => sourceClient.listReviewRepositoryRefs(repositoryPath),
    enabled: kind === 'repository' && repositoryPath !== '',
  });

  const linkIsPullRequest = useMemo(() => pullRequestUrls([pullRequestUrl.trim()]).length > 0, [pullRequestUrl]);
  const canCreate = kind === 'pull-request' ? linkIsPullRequest : repositoryPath !== '';

  const create = useMutation({
    mutationFn: () => sourceClient.createStandaloneReview(kind === 'pull-request'
      ? { pullRequestUrl: pullRequestUrl.trim(), ...(title.trim() ? { title: title.trim() } : {}) }
      : { repositoryPath, ...(ref ? { ref } : {}), ...(title.trim() ? { title: title.trim() } : {}) }),
    onSuccess: async ({ review }) => {
      // The source picked here is the one the review opens on, so it is
      // recorded as this review's remembered source before it is ever shown.
      if (review.source.kind === 'repository' && review.source.ref) writeReviewStackSource(`review:${review.id}`, review.source.ref);
      if (review.source.kind === 'pull-request') writeReviewStackSource(`review:${review.id}`, review.source.url);
      await queryClient.invalidateQueries({ queryKey: standaloneReviewQueryKeys.list });
      onCreated(review);
    },
  });

  return (
    <ModalDialog className="new-review-dialog" label="New review" onClose={onClose} closeDisabled={create.isPending}>
      <header className="dialog-header">
        <h2>New review</h2>
        <p className="dialog-subtitle">Paste a pull request link, or pick a repository and branch.</p>
      </header>
      <div className="dialog-body">
        <div className="segmented-control" role="radiogroup" aria-label="Review source">
          <button type="button" role="radio" aria-checked={kind === 'pull-request'} className={`button secondary compact ${kind === 'pull-request' ? 'active' : ''}`} onClick={() => setKind('pull-request')}>Pull request</button>
          <button type="button" role="radio" aria-checked={kind === 'repository'} className={`button secondary compact ${kind === 'repository' ? 'active' : ''}`} onClick={() => setKind('repository')}>Repository</button>
        </div>

        {kind === 'pull-request' ? (
          <label className="field">
            <span>GitHub pull request link</span>
            <input
              type="url"
              value={pullRequestUrl}
              autoFocus
              placeholder="https://github.com/owner/repo/pull/123"
              onChange={(event) => setPullRequestUrl(event.target.value)}
            />
            {pullRequestUrl.trim() !== '' && !linkIsPullRequest && <small className="error-message">That is not a GitHub pull request link.</small>}
          </label>
        ) : (
          <>
            <label className="field">
              <span>Repository</span>
              <select value={repositoryPath} onChange={(event) => { setRepositoryPath(event.target.value); setRef(''); }}>
                <option value="">Select a repository…</option>
                {(repositories.data?.repositories ?? []).map((repository) => (
                  <option key={repository.path} value={repository.path}>{repository.label}</option>
                ))}
              </select>
              {repositories.isError && <small className="error-message">Could not list repositories.</small>}
            </label>
            <label className="field">
              <span>Branch</span>
              <select value={ref} disabled={repositoryPath === '' || refs.isLoading} onChange={(event) => setRef(event.target.value)}>
                <option value="">Working tree</option>
                {(refs.data?.refs.branches ?? []).map((branch) => (
                  <option key={branch.name} value={branchSourceId(branch.name)}>{branch.name}</option>
                ))}
                {(refs.data?.refs.worktrees ?? []).filter((worktree) => !worktree.current).map((worktree) => (
                  <option key={worktree.path} value={worktreeSourceId(worktree.path)}>Worktree {worktree.path.split('/').filter(Boolean).pop()}</option>
                ))}
              </select>
            </label>
          </>
        )}

        <label className="field">
          <span>Title <small>(optional)</small></span>
          <input type="text" value={title} placeholder="Named after the source when left blank" onChange={(event) => setTitle(event.target.value)} />
        </label>
        {create.isError && <p className="error-message">{create.error instanceof Error ? create.error.message : 'Could not create the review.'}</p>}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="button secondary" onClick={onClose} disabled={create.isPending}>Cancel</button>
        <button type="button" className="button" disabled={!canCreate || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating…' : 'Create review'}
        </button>
      </footer>
    </ModalDialog>
  );
}
