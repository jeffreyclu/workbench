import { useQuery } from '@tanstack/react-query';
import { api } from '../../data/api';

export const tabCountsQueryKey = ['tab-counts'] as const;

/**
 * The only source for Active/Archive numbers anywhere in the app. Badges must
 * never derive a number from a loaded list page: the list reflects search and
 * filters, while the tab labels the whole view.
 */
export function useTabCounts() {
  return useQuery({ queryKey: tabCountsQueryKey, queryFn: api.getTabCounts });
}
