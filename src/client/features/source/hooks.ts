import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { BrokerConnection } from '../../../shared/contracts';
import { sourceData, sourceQueryKeys } from './data';
import { initialSourceAuthorizationState, reduceSourceAuthorization } from './state';

export const SOURCE_AUTHORIZATION_POLL_INTERVAL_MS = 2_000;

export function useSourceConnections() {
  // Connections change through explicit mutations and the shared realtime
  // invalidation channel. Polling this dialog duplicates requests without
  // making the server response more current.
  return useQuery({ queryKey: sourceQueryKeys.connections, queryFn: sourceData.listConnections });
}

export function useSourceAuthorization(connection: BrokerConnection) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reduceSourceAuthorization, initialSourceAuthorizationState);
  const previousConnectionState = useRef(connection.state);

  const checkAuthorization = useCallback(async () => {
    dispatch({ type: 'check-started' });
    try {
      const result = await sourceData.listConnections();
      queryClient.setQueryData(sourceQueryKeys.connections, result);
      const checkedConnection = result.connections.find((candidate) => candidate.id === connection.id);
      dispatch({ type: 'check-finished', authorized: checkedConnection?.state === 'connected' });
    } catch (error) {
      dispatch({
        type: 'check-failed',
        error: error instanceof Error ? error.message : 'Could not check the connection.',
      });
    }
  }, [connection.id, queryClient]);

  useEffect(() => {
    if (state.status !== 'awaiting-auth') return;
    const timer = window.setTimeout(checkAuthorization, SOURCE_AUTHORIZATION_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [checkAuthorization, state.status]);

  useEffect(() => {
    const previousState = previousConnectionState.current;
    previousConnectionState.current = connection.state;
    if (connection.state === 'connected') {
      if (state.status !== 'idle' && state.status !== 'authorized') {
        dispatch({ type: 'check-finished', authorized: true });
      }
      return;
    }
    if (previousState === 'connected' && state.status === 'authorized') dispatch({ type: 'reset' });
  }, [connection.state, state.status]);

  const startAuthorization = useCallback((authorizationUrl: string) => {
    dispatch({ type: 'authorization-started', authorizationUrl });
  }, []);

  return { state, startAuthorization, checkAuthorization };
}
