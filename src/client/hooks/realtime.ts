import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ToastTone } from '../state/toast-store';

const realtimeTopics = ['work-items', 'shared', 'shared-metadata', 'shared-messages', 'discovery', 'runtime', 'insights', 'artifacts'] as const;
type RealtimeTopic = typeof realtimeTopics[number];

type RealtimeMessage =
  | { type: 'ready' }
  | { type: 'invalidate'; topics: RealtimeTopic[]; conversationId?: string }
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
    ['work-items'], ['work-item'], ['work-item-counts'], ['archived-work-items'],
    ['pinned-reminder'], ['conversation-linkable-tasks'], ['dependency-candidates'], ['task-link-candidates'],
    ['work-item-workspaces'], ['projects'], ['stale-references'],
    ['workspace-diff'], ['workspace-diff-snapshots'], ['workspace-diff-refs'], ['workspace-diff-ref'],
    ['workspace-diff-ref-commits'], ['workspace-diff-file-source'], ['workspace-diff-status'],
    ['review-auto-score'], ['review-assist-cache'],
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

function isRealtimeMessage(value: unknown): value is RealtimeMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  if (value.type === 'ready') return true;
  if (value.type === 'notification') {
    const notification = value as Partial<RealtimeNotification>;
    return (notification.tone === 'success' || notification.tone === 'error' || notification.tone === 'info')
      && typeof notification.message === 'string'
      && (notification.description === undefined || typeof notification.description === 'string')
      && (notification.duration === undefined || (typeof notification.duration === 'number' && Number.isFinite(notification.duration) && notification.duration >= 0))
      && (notification.action === undefined || (typeof notification.action.label === 'string' && typeof notification.action.route === 'string' && notification.action.route.startsWith('/')));
  }
  if (value.type === 'diff-confidence') {
    const message = value as Partial<RealtimeDiffConfidence>;
    return Boolean(message.assessments) && typeof message.assessments === 'object';
  }
  if (value.type === 'review-score') {
    const message = value as Partial<RealtimeReviewScore>;
    return typeof message.decisionId === 'string'
      && typeof message.revision === 'string'
      && (message.answer === null || typeof message.answer === 'string')
      && (message.error === null || typeof message.error === 'string')
      && typeof message.completed === 'number'
      && typeof message.total === 'number'
      && Boolean(message.scope) && typeof message.scope === 'object';
  }
  return value.type === 'invalidate'
    && 'topics' in value
    && Array.isArray(value.topics)
    && value.topics.every((topic) => typeof topic === 'string' && realtimeTopics.includes(topic as RealtimeTopic));
}

export function realtimeUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/realtime`;
}

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
  /** Cancels any pending backoff/poll wait and makes an immediate connection attempt. */
  retryNow: () => void;
};

/**
 * Keeps cached server data fresh across Workbench tabs and clients. The socket
 * transports cache invalidations and server-authored user notifications. Records
 * still come from REST, so socket payloads never need to carry application data.
 */
export function useRealtimeNotifications(onNotification: (notification: RealtimeNotification) => void): RealtimeConnection {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>('connecting');
  const [browserOffline, setBrowserOffline] = useState(() => typeof navigator !== 'undefined' && 'onLine' in navigator ? !navigator.onLine : false);
  const retryRef = useRef<() => void>(() => {});

  // Online/offline are hints only: they can nudge a retry sooner, but the
  // actual connection state above always comes from the socket itself.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOffline = () => setBrowserOffline(true);
    const handleOnline = () => {
      setBrowserOffline(false);
      retryRef.current();
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let invalidationTimer: number | null = null;
    const pendingInvalidationTopics = new Set<RealtimeTopic>();
    const pendingMessagesConversationIds = new Set<string>();
    // Any 'shared-messages' event this batch that did not name a
    // conversation (there is none today, but nothing guarantees that stays
    // true) forces a broad fallback rather than silently under-invalidating.
    let pendingMessagesBroad = false;
    let attempts = 0;
    let disposed = false;
    let manualRetryRequested = false;

    const flushInvalidations = () => {
      invalidationTimer = null;
      if (disposed || pendingInvalidationTopics.size === 0) return;
      invalidateRealtimeTopics(queryClient, [...pendingInvalidationTopics], pendingMessagesBroad ? new Set() : pendingMessagesConversationIds);
      pendingInvalidationTopics.clear();
      pendingMessagesConversationIds.clear();
      pendingMessagesBroad = false;
    };

    const queueInvalidations = (topics: readonly RealtimeTopic[], conversationId?: string) => {
      for (const topic of topics) pendingInvalidationTopics.add(topic);
      if (topics.includes('shared-messages')) {
        if (conversationId) pendingMessagesConversationIds.add(conversationId);
        else pendingMessagesBroad = true;
      }
      if (invalidationTimer === null) invalidationTimer = window.setTimeout(flushInvalidations, REALTIME_INVALIDATION_BATCH_MS);
    };

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(realtimeUrl());
      socket.addEventListener('open', () => {
        attempts = 0;
        setConnectionState('connected');
      });
      socket.addEventListener('message', (event) => {
        try {
          const message: unknown = JSON.parse(typeof event.data === 'string' ? event.data : '');
          if (!isRealtimeMessage(message)) return;
          // A reconnect may have missed invalidations while the socket was
          // down. Refresh every active realtime-backed query once when the
          // server confirms this connection, then stay event-driven.
          if (message.type === 'ready') queueInvalidations(realtimeTopics);
          if (message.type === 'invalidate') queueInvalidations(message.topics, message.conversationId);
          if (message.type === 'notification') onNotification(message);
          if (message.type === 'review-score' && message.completed >= message.total) {
            const scopeId = 'conversationId' in message.scope ? message.scope.conversationId : message.scope.workItemId;
            void queryClient.invalidateQueries({ queryKey: ['review-auto-score', scopeId, message.revision] });
          }
          if (message.type === 'diff-confidence' || message.type === 'review-score') for (const listener of realtimeMessageListeners) listener(message);
        } catch {
          // Ignore malformed frames. The server never sends application data.
        }
      });
      socket.addEventListener('close', () => {
        if (disposed) return;
        if (manualRetryRequested) {
          manualRetryRequested = false;
          attempts = 0;
          connect();
          return;
        }
        setConnectionState('reconnecting');
        const delay = Math.min(30_000, 1_000 * 2 ** attempts++);
        const jitter = Math.round(delay * (0.2 * Math.random()));
        reconnectTimer = window.setTimeout(connect, delay + jitter);
      });
    };

    // Skips any pending backoff wait and makes an immediate connection
    // attempt — used by the "Retry now" action and by the browser 'online'
    // hint. The resulting connection state still comes from the socket.
    retryRef.current = () => {
      if (disposed) return;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        manualRetryRequested = true;
        socket.close();
      } else {
        attempts = 0;
        connect();
      }
    };

    connect();
    return () => {
      disposed = true;
      retryRef.current = () => {};
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (invalidationTimer !== null) window.clearTimeout(invalidationTimer);
      pendingInvalidationTopics.clear();
      socket?.close();
    };
  }, [onNotification, queryClient]);

  const retryNow = useCallback(() => retryRef.current(), []);

  return { state: connectionState, browserOffline, retryNow };
}
