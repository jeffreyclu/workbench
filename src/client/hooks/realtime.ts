import { useCallback, useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ToastTone } from '../state/toast-store';
import { realtimeUrl, socketTransport, type SocketConnectionState } from '../data/socket-transport';
import { realtimeTopics, type RealtimeTopic } from '../../shared/realtime-protocol';

export { realtimeUrl };

type RealtimeMessage =
  | { type: 'ready' }
  | { type: 'invalidate'; topics: RealtimeTopic[]; conversationId?: string; workItemId?: string }
  | { type: 'notification'; tone: ToastTone; message: string; description?: string; duration?: number; action?: { label: string; route: string } }
  | { type: 'diff-confidence'; assessments: Record<string, { risk: number | null; reasoning: string }> }
  | { type: 'review-score'; scope: { workItemId: string } | { conversationId: string }; revision: string; decisionId: string; answer: string | null; error: string | null; completed: number; total: number };

export type RealtimeNotification = Extract<RealtimeMessage, { type: 'notification' }>;
export type RealtimeDiffConfidence = Extract<RealtimeMessage, { type: 'diff-confidence' }>;
export type RealtimeReviewScore = Extract<RealtimeMessage, { type: 'review-score' }>;
const realtimeMessageListeners = new Set<(message: RealtimeMessage) => void>();

export function subscribeRealtimeMessages(listener: (message: RealtimeMessage) => void): () => void {
  realtimeMessageListeners.add(listener);
  return () => realtimeMessageListeners.delete(listener);
}

/**
 * 'connecting' is the initial/first-attempt state; 'reconnecting' means an
 * established connection was lost and backoff is in progress. Callers use
 * this to warn that cached data may be stale while the socket is down.
 */
export type RealtimeConnectionState = 'connecting' | 'connected' | 'reconnecting';

const REALTIME_INVALIDATION_BATCH_MS = 250;

const topicQueryKeys: Record<RealtimeTopic, readonly (readonly unknown[])[]> = {
  'work-items': [
    ['work-items'], ['work-item-counts'], ['archived-work-items'],
    ['pinned-reminder'], ['conversation-linkable-tasks'], ['dependency-candidates'], ['task-link-candidates'],
    ['projects'],
  ],
  shared: [
    ['shared-conversations'], ['shared-conversation'], ['shared-messages'], ['shared-message-activity'],
    ['conversation-count'], ['notification-conversations'], ['conversation-unread-count'], ['conversation-attention-count'], ['shared-conversation-search'],
    ['shared-agent-events'], ['conversation-workspaces'], ['workspace-diff-status'],
    ['workspace-diff'], ['workspace-diff-snapshots'], ['workspace-diff-refs'], ['workspace-diff-ref'],
    ['workspace-diff-ref-commits'], ['workspace-diff-file-source'],
    ['review-auto-score'], ['review-assist-cache'], ['retrieved-memory'],
    ['promotion-queue-status'], ['agent-accounts'],
  ],
  'shared-metadata': [
    ['shared-conversations'], ['shared-conversation'], ['conversation-count'],
    ['notification-conversations'], ['conversation-unread-count'], ['conversation-attention-count'],
  ],
  // ['shared-messages'] and ['shared-agent-events'] are deliberately absent
  // here: this topic fires on every streamed token from every running agent
  // across every conversation, so invalidating those two broadly would
  // refetch the conversation Jeffrey has open on someone else's unrelated
  // agent activity. invalidateRealtimeTopics scopes those two to the
  // conversation id the server actually sent, when it sent one.
  'shared-messages': [
    ['shared-message-activity'],
    ['workspace-diff-status'],
    ['work-item-workspaces'], ['conversation-workspaces'], ['promotion-queue-status'], ['runtime-preview-status'],
  ],
  discovery: [['discovery'], ['discovery-merge-targets']],
  runtime: [['runtime-preview-status'], ['promotion-queue-status'], ['health'], ['agent-accounts'], ['ai-provider-availability'], ['source-connections'], ['figma-scope']],
  insights: [['insights'], ['usage'], ['memory-diagnostics'], ['mcp-quality'], ['global-memory-search']],
  artifacts: [['artifacts'], ['artifact'], ['artifact-link-candidates']],
};

const workItemScopedQueryKeys: readonly (readonly unknown[])[] = [
  ['work-item'], ['work-item-workspaces'], ['stale-references'],
  ['workspace-diff'], ['workspace-diff-snapshots'], ['workspace-diff-refs'], ['workspace-diff-ref'],
  ['workspace-diff-ref-commits'], ['workspace-diff-file-source'], ['workspace-diff-status'],
  ['review-auto-score'], ['review-assist-cache'],
];

/**
 * `messagesConversationIds` are the conversations the server actually named
 * for a batch of 'shared-messages' events. When every event in the batch
 * named one, only those conversations' message/event queries are refetched
 * instead of every open conversation's. An empty set (a 'ready' resync, or
 * a `ready` catch-up, which carries no per-event ids) falls back to
 * invalidating both broadly once.
 */
export function invalidateRealtimeTopics(
  queryClient: QueryClient,
  topics: readonly RealtimeTopic[],
  messagesConversationIds: ReadonlySet<string> = new Set(),
  workItemIds: ReadonlySet<string> = new Set(),
  invalidateAllWorkItemDetails = false,
): void {
  const invalidated = new Set<string>();
  for (const topic of new Set(topics)) {
    for (const queryKey of topicQueryKeys[topic]) {
      const signature = JSON.stringify(queryKey);
      if (invalidated.has(signature)) continue;
      invalidated.add(signature);
      void queryClient.invalidateQueries({ queryKey });
    }
  }
  if (topics.includes('work-items')) {
    for (const queryKey of workItemScopedQueryKeys) {
      const signature = JSON.stringify(queryKey);
      if (invalidated.has(signature)) continue;
      if (invalidateAllWorkItemDetails) {
        invalidated.add(signature);
        void queryClient.invalidateQueries({ queryKey });
        continue;
      }
      for (const workItemId of workItemIds) {
        void queryClient.invalidateQueries({
          predicate: (query) => query.queryKey.length >= queryKey.length
            && queryKey.every((part, index) => query.queryKey[index] === part)
            && query.queryKey.includes(workItemId),
        });
      }
    }
  }
  if (!topics.includes('shared-messages')) return;
  if (messagesConversationIds.size > 0) {
    for (const conversationId of messagesConversationIds) {
      void queryClient.invalidateQueries({ queryKey: ['shared-messages', conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['shared-agent-events', conversationId] });
    }
  } else {
    void queryClient.invalidateQueries({ queryKey: ['shared-messages'] });
    void queryClient.invalidateQueries({ queryKey: ['shared-agent-events'] });
  }
}

export type RealtimeConnection = {
  state: RealtimeConnectionState;
  /** Browser online/offline event, used only as a UI hint to show the status strip sooner — never as the source of truth for `state`. */
  browserOffline: boolean;
  /** Cancels pending reconnect backoff and makes an immediate connection attempt. */
  retryNow: () => void;
};

/**
 * Owns the application socket's React lifecycle. Scoped server events refresh
 * affected TanStack Query records through socket RPC; no invalidation starts an
 * HTTP request.
 */
export function useRealtimeNotifications(onNotification: (notification: RealtimeNotification) => void): RealtimeConnection {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>(socketTransport.connectionState);
  const [browserOffline, setBrowserOffline] = useState(() => typeof navigator !== 'undefined' && 'onLine' in navigator ? !navigator.onLine : false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOffline = () => setBrowserOffline(true);
    const handleOnline = () => {
      setBrowserOffline(false);
      socketTransport.retryNow();
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  useEffect(() => {
    let invalidationTimer: number | null = null;
    const pendingInvalidationTopics = new Set<RealtimeTopic>();
    const pendingMessagesConversationIds = new Set<string>();
    const pendingWorkItemIds = new Set<string>();
    let pendingMessagesBroad = false;
    let pendingWorkItemsBroad = false;

    const flushInvalidations = () => {
      invalidationTimer = null;
      if (pendingInvalidationTopics.size === 0) return;
      invalidateRealtimeTopics(
        queryClient,
        [...pendingInvalidationTopics],
        pendingMessagesBroad ? new Set() : pendingMessagesConversationIds,
        pendingWorkItemIds,
        pendingWorkItemsBroad,
      );
      pendingInvalidationTopics.clear();
      pendingMessagesConversationIds.clear();
      pendingWorkItemIds.clear();
      pendingMessagesBroad = false;
      pendingWorkItemsBroad = false;
    };

    const queueInvalidations = (topics: readonly RealtimeTopic[], conversationId?: string, workItemId?: string, resync = false) => {
      for (const topic of topics) pendingInvalidationTopics.add(topic);
      if (topics.includes('shared-messages')) {
        if (conversationId) pendingMessagesConversationIds.add(conversationId);
        else pendingMessagesBroad = true;
      }
      if (topics.includes('work-items')) {
        if (workItemId) pendingWorkItemIds.add(workItemId);
        if (resync) pendingWorkItemsBroad = true;
      }
      if (invalidationTimer === null) invalidationTimer = window.setTimeout(flushInvalidations, REALTIME_INVALIDATION_BATCH_MS);
    };
    const unsubscribeState = socketTransport.subscribeState((state: SocketConnectionState) => setConnectionState(state));
    const unsubscribeEvents = socketTransport.subscribeEvents((event) => {
      if (event.kind === 'resync-required') {
        queueInvalidations(realtimeTopics, undefined, undefined, true);
        return;
      }
      if (event.kind === 'invalidate') queueInvalidations(event.topics, event.conversationId, event.workItemId);
      if (event.kind === 'notification') onNotification({
        type: 'notification',
        tone: event.tone,
        message: event.message,
        description: event.description,
        duration: event.duration,
        action: event.action,
      });
      if (event.kind === 'review-score' && event.completed >= event.total) {
        const scopeId = 'conversationId' in event.scope ? event.scope.conversationId : event.scope.workItemId;
        void queryClient.invalidateQueries({ queryKey: ['review-auto-score', scopeId, event.revision] });
      }
      if (event.kind === 'diff-confidence' || event.kind === 'review-score') {
        const { kind, ...payload } = event;
        const message = { ...payload, type: kind } as RealtimeDiffConfidence | RealtimeReviewScore;
        for (const listener of realtimeMessageListeners) listener(message);
      }
    });
    return () => {
      if (invalidationTimer !== null) window.clearTimeout(invalidationTimer);
      pendingInvalidationTopics.clear();
      unsubscribeState();
      unsubscribeEvents();
    };
  }, [onNotification, queryClient]);

  const retryNow = useCallback(() => socketTransport.retryNow(), []);

  return { state: connectionState, browserOffline, retryNow };
}
