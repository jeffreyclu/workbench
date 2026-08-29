import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sourceClient } from '../../data/source-client.js';
import { subscribeRealtimeMessages } from '../../hooks/realtime.js';

export type AutoScoreResult = { answer: string | null; error: string | null };

export type AutoReviewScores = {
  results: Map<string, AutoScoreResult>;
  running: boolean;
  completed: number;
  total: number;
  /** Decisions the background pass deliberately left unscored, so the queue can
   * say so instead of implying the whole diff was covered. */
  skipped: number;
};

const EMPTY: AutoReviewScores = { results: new Map(), running: false, completed: 0, total: 0, skipped: 0 };

/**
 * Background risk scores for the decisions in one diff revision.
 *
 * The server starts scoring when an agent comes to rest, so results arrive
 * without anyone clicking. Two sources feed the same map: a one-shot snapshot
 * for whatever settled before this pane opened, and live realtime frames after
 * that. Failures are carried through rather than dropped, so a decision that
 * could not be scored shows its error and its retry instead of reading as
 * merely unscored.
 */
export function useAutoReviewScores(scope: { workItemId: string | null; conversationId: string | null }, revision: string | undefined): AutoReviewScores {
  const queryClient = useQueryClient();
  const { workItemId, conversationId } = scope;
  const [live, setLive] = useState<AutoReviewScores>(EMPTY);

  const snapshot = useQuery({
    queryKey: ['review-auto-score', workItemId ?? conversationId, revision],
    queryFn: () => sourceClient.getReviewAutoScore(
      conversationId ? { conversationId, revision: revision! } : { workItemId: workItemId!, revision: revision! },
    ),
    enabled: Boolean(revision) && Boolean(workItemId || conversationId),
    staleTime: 30_000,
    // This GET only observes durable cache/job state and asynchronously nudges
    // a missing pass server-side. Poll only until that pass exists and settles;
    // individual scores still arrive immediately over WebSocket.
    refetchInterval: (query) => {
      const current = query.state.data?.snapshot;
      return !current || current.running ? 2_000 : false;
    },
  });

  useEffect(() => {
    setLive(EMPTY);
  }, [revision, workItemId, conversationId]);

  useEffect(() => {
    if (!revision) return undefined;
    return subscribeRealtimeMessages((message) => {
      if (message.type !== 'review-score' || message.revision !== revision) return;
      const matches = conversationId
        ? 'conversationId' in message.scope && message.scope.conversationId === conversationId
        : 'workItemId' in message.scope && message.scope.workItemId === workItemId;
      if (!matches) return;
      setLive((previous) => {
        const results = new Map(previous.results);
        results.set(message.decisionId, { answer: message.answer, error: message.error });
        return { ...previous, results, completed: message.completed, total: message.total, running: message.completed < message.total };
      });
      // The answer is already durable in the assist cache; refreshing the
      // panel's cache-only read keeps a decision the reviewer later reopens
      // consistent with what streamed in, including after a reload.
      if (message.answer) void queryClient.invalidateQueries({ queryKey: ['review-assist-cache', message.decisionId] });
    });
  }, [revision, workItemId, conversationId, queryClient]);

  return useMemo(() => {
    const replay = snapshot.data?.snapshot;
    if (!replay && live.results.size === 0) return EMPTY;
    const results = new Map<string, AutoScoreResult>();
    for (const entry of replay?.entries ?? []) results.set(entry.decisionId, { answer: entry.answer, error: entry.error });
    // Live frames win: they are strictly newer than the snapshot they follow.
    for (const [decisionId, result] of live.results) results.set(decisionId, result);
    const completed = Math.max(replay?.completed ?? 0, live.completed);
    const total = Math.max(replay?.total ?? 0, live.total);
    return { results, completed, total, skipped: replay?.skipped ?? live.skipped, running: total > 0 && completed < total };
  }, [snapshot.data, live]);
}
