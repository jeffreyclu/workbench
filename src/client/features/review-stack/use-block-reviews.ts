import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpsertDiffBlockReviewInput } from '../../../shared/contracts.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { reviewStackData, reviewStackQueryKeys } from './data.js';

export function useDiffBlockReviews(scope: WorkspaceDiffScope, revision: string | undefined) {
  return useQuery({
    queryKey: reviewStackQueryKeys.blockReviews(scope, revision),
    queryFn: () => reviewStackData.getBlockReviews(scope, revision!),
    enabled: Boolean(revision),
    staleTime: Infinity,
  });
}

export function useUpsertDiffBlockReview(scope: WorkspaceDiffScope, revision: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<UpsertDiffBlockReviewInput, 'revision'>) => reviewStackData.upsertBlockReview(scope, { ...input, revision: revision! }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: reviewStackQueryKeys.blockReviews(scope, revision) });
    },
  });
}
