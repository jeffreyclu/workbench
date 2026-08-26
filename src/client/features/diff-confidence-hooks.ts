import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

/** Assess the changed blocks of the file currently on screen. Keyed by block
 * content so switching files or refreshing a diff re-asks, but re-rendering
 * does not. One failure is final: each retry would spawn another model run.
 *
 * `select` flattens the response to the score map and tolerates its absence: a
 * diff must still render if the assessment endpoint answers with something
 * unexpected, so callers get a map with missing keys rather than a crash. */
export function useDiffBlockConfidence(blocks: Array<{ key: string; lines: string[] }>) {
  return useQuery({
    queryKey: ['diff-confidence', JSON.stringify(blocks)],
    queryFn: () => api.assessDiffBlocks(blocks),
    enabled: blocks.length > 0,
    staleTime: Infinity,
    retry: false,
    select: (result) => result.assessments ?? {},
  });
}
