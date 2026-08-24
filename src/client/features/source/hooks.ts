import { useQuery } from '@tanstack/react-query';
import { sourceData, sourceQueryKeys } from './data';

export function useSourceConnections() {
  return useQuery({ queryKey: sourceQueryKeys.connections, queryFn: sourceData.listConnections, refetchInterval: 2_000 });
}
