import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ToastTone } from '../state/toast-store';

const realtimeTopics = ['work-items', 'shared', 'discovery', 'runtime', 'insights', 'artifacts'] as const;
type RealtimeTopic = typeof realtimeTopics[number];

type RealtimeMessage =
  | { type: 'ready' }
  | { type: 'invalidate'; topics: RealtimeTopic[] }
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
export type RealtimeConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'polling';

const MAX_WEBSOCKET_RECONNECT_ATTEMPTS = 3;
const HTTPS_FALLBACK_POLL_MS = 1_500;
const HTTPS_FALLBACK_WS_PROBE_MS = 30_000;
const AGENT_POLL_TOPICS: readonly RealtimeTopic[] = ['shared', 'work-items', 'insights'];

const topicQueryKeys: Record<RealtimeTopic, readonly (readonly unknown[])[]> = {
  'work-items': [
    ['work-items'], ['work-item'], ['work-item-counts'], ['archived-work-items'],
    ['pinned-reminder'], ['conversation-linkable-tasks'], ['dependency-candidates'], ['task-link-candidates'],
  ],
  shared: [
    ['shared-conversations'], ['shared-conversation'], ['shared-messages'], ['shared-message-activity'],
    ['conversation-count'], ['notification-conversations'], ['conversation-unread-count'], ['conversation-attention-count'], ['shared-search'],
  ],
  discovery: [['discovery'], ['discovery-merge-targets']],
  runtime: [['runtime-preview-status']],
  insights: [['insights'], ['usage']],
  artifacts: [['artifacts'], ['artifact']],
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

export function invalidateRealtimeTopics(queryClient: QueryClient, topics: readonly RealtimeTopic[]): void {
  for (const topic of new Set(topics)) {
    for (const queryKey of topicQueryKeys[topic]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }
}

/**
 * Keeps cached server data fresh across Workbench tabs and clients. The socket
 * transports cache invalidations and server-authored user notifications. Records
 * still come from REST, so socket payloads never need to carry application data.
 */
export function useRealtimeNotifications(onNotification: (notification: RealtimeNotification) => void): RealtimeConnectionState {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>('connecting');

  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pollingTimer: number | null = null;
    let recoveryProbeTimer: number | null = null;
    let attempts = 0;
    let disposed = false;

    const startHttpsFallback = () => {
      if (disposed || pollingTimer !== null) return;
      // The socket carries invalidations only. Invalidating active queries
      // makes TanStack Query fetch their normal HTTPS endpoints, preserving
      // live agent output when a proxy, VPN, or browser policy rejects WS.
      setConnectionState('polling');
      invalidateRealtimeTopics(queryClient, AGENT_POLL_TOPICS);
      pollingTimer = window.setInterval(() => invalidateRealtimeTopics(queryClient, AGENT_POLL_TOPICS), HTTPS_FALLBACK_POLL_MS);
      // Stay useful over HTTPS, but periodically make one recovery probe.
      // A failed probe returns here without fast retries; the next probe is
      // still bounded to this low-frequency interval.
      recoveryProbeTimer = window.setInterval(connect, HTTPS_FALLBACK_WS_PROBE_MS);
    };

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(realtimeUrl());
      socket.addEventListener('open', () => {
        attempts = 0;
        if (pollingTimer !== null) {
          window.clearInterval(pollingTimer);
          pollingTimer = null;
        }
        if (recoveryProbeTimer !== null) {
          window.clearInterval(recoveryProbeTimer);
          recoveryProbeTimer = null;
        }
        setConnectionState('connected');
      });
      socket.addEventListener('message', (event) => {
        try {
          const message: unknown = JSON.parse(typeof event.data === 'string' ? event.data : '');
          if (!isRealtimeMessage(message)) return;
          if (message.type === 'invalidate') invalidateRealtimeTopics(queryClient, message.topics);
          if (message.type === 'notification') onNotification(message);
          if (message.type === 'diff-confidence' || message.type === 'review-score') for (const listener of realtimeMessageListeners) listener(message);
        } catch {
          // Ignore malformed frames. The server never sends application data.
        }
      });
      socket.addEventListener('close', () => {
        if (disposed) return;
        if (attempts >= MAX_WEBSOCKET_RECONNECT_ATTEMPTS) {
          startHttpsFallback();
          return;
        }
        setConnectionState('reconnecting');
        const delay = Math.min(30_000, 1_000 * 2 ** attempts++);
        const jitter = Math.round(delay * (0.2 * Math.random()));
        reconnectTimer = window.setTimeout(connect, delay + jitter);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pollingTimer !== null) window.clearInterval(pollingTimer);
      if (recoveryProbeTimer !== null) window.clearInterval(recoveryProbeTimer);
      socket?.close();
    };
  }, [onNotification, queryClient]);

  return connectionState;
}
