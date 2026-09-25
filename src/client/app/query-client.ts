import { MutationCache, QueryClient, type DefaultOptions } from '@tanstack/react-query';
import { tabCountsQueryKey } from '../features/navigation/data';

/**
 * The application WebSocket is the durable record transport, not a navigation
 * lifecycle hook.
 *
 * A successful read stays valid for this browser session. Server mutations and
 * background work explicitly invalidate affected keys over WebSocket; user
 * refresh controls call `refetch()` directly. Remounting a route, focusing the
 * window, reconnecting the browser, or waiting for a timer must never create a
 * request by itself.
 */
export const workbenchQueryDefaults = {
  queries: {
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  },
} satisfies DefaultOptions;

/**
 * Tab counts are refetched after every settled mutation, not only when the
 * WebSocket reports a change, so a create, archive, restore, complete, or
 * delete updates the Active/Archive numbers as soon as the server answers.
 */
export function createWorkbenchQueryClient(defaultOptions: DefaultOptions = workbenchQueryDefaults): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    defaultOptions,
    mutationCache: new MutationCache({ onSettled: () => queryClient.invalidateQueries({ queryKey: tabCountsQueryKey }) }),
  });
  return queryClient;
}
