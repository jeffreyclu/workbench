import { useCallback, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../data/api';
import { readAiProvider, writeAiProvider } from '../lib/preferences';
import type { AiProviderChoice } from '../../shared/ai-providers';

/** The selector appears on several surfaces at once — the create-task dialog,
 * the review pane, Settings — and they are one choice, not several. A module
 * store keeps every mounted selector in step without threading the value
 * through unrelated component trees. */
const listeners = new Set<() => void>();
let current: AiProviderChoice | null = null;

function snapshot(): AiProviderChoice {
  if (current === null) current = readAiProvider();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Browser-local default for every surface that is not a conversation. The
 * conversation composer persists its own choice per conversation instead,
 * because turn grounding runs server-side with no request body to carry it. */
export function useAiProvider(): { provider: AiProviderChoice; setProvider: (next: AiProviderChoice) => void } {
  const provider = useSyncExternalStore(subscribe, snapshot, () => 'auto' as AiProviderChoice);
  const setProvider = useCallback((next: AiProviderChoice) => {
    current = next;
    writeAiProvider(next);
    for (const listener of listeners) listener();
  }, []);
  return { provider, setProvider };
}

/** Availability is a server fact — it depends on a key this machine holds and
 * on the account profile the turn runs under — so the selector asks rather
 * than guessing. */
export function useAiProviderAvailability(provider: AiProviderChoice, accountProfile?: string | null) {
  return useQuery({
    queryKey: ['ai-provider-availability', provider, accountProfile ?? null],
    queryFn: () => api.getAiProviderAvailability(provider, accountProfile),
    staleTime: 60_000,
  });
}
