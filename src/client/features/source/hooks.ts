import { useQuery } from '@tanstack/react-query';
import { sourceData, sourceQueryKeys } from './data';

export function useSourceConnections() {
  // Connections change through explicit mutations and the shared realtime
  // invalidation channel. Polling this dialog duplicates requests without
  // making the server response more current.
  return useQuery({ queryKey: sourceQueryKeys.connections, queryFn: sourceData.listConnections });
}
