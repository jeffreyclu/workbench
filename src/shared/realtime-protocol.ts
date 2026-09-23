export const REALTIME_PROTOCOL_VERSION = 1 as const;

export type RealtimeTopic = 'work-items' | 'shared' | 'shared-metadata' | 'shared-messages' | 'discovery' | 'runtime' | 'insights' | 'artifacts';

export type RealtimeNotification = {
  kind: 'notification';
  tone: 'success' | 'error' | 'info';
  message: string;
  description?: string;
  duration?: number;
  action?: { label: string; route: string };
};

export type RealtimeEvent =
  | { kind: 'invalidate'; topics: RealtimeTopic[]; conversationId?: string; workItemId?: string }
  | RealtimeNotification
  | { kind: 'diff-confidence'; assessments: Record<string, { risk: number | null; reasoning: string }> }
  | {
    kind: 'review-score';
    scope: { workItemId: string } | { conversationId: string };
    revision: string;
    decisionId: string;
    answer: string | null;
    error: string | null;
    completed: number;
    total: number;
  };

export type RealtimeClientFrame =
  | { type: 'hello'; protocol: typeof REALTIME_PROTOCOL_VERSION; clientId: string; resumeFrom: number | null }
  | { type: 'request'; protocol: typeof REALTIME_PROTOCOL_VERSION; id: string; operation: string; input: unknown; mode: 'read' | 'command' }
  | { type: 'cancel'; protocol: typeof REALTIME_PROTOCOL_VERSION; id: string };

export type RealtimeServerFrame =
  | { type: 'ready'; protocol: typeof REALTIME_PROTOCOL_VERSION; sessionId: string; sequence: number; resumed: boolean }
  | { type: 'response'; protocol: typeof REALTIME_PROTOCOL_VERSION; id: string; data: unknown }
  | { type: 'progress'; protocol: typeof REALTIME_PROTOCOL_VERSION; id: string; data: unknown }
  | { type: 'error'; protocol: typeof REALTIME_PROTOCOL_VERSION; id: string | null; code: string; message: string; retryable: boolean }
  | { type: 'event'; protocol: typeof REALTIME_PROTOCOL_VERSION; sequence: number; event: RealtimeEvent };

export const realtimeTopics: readonly RealtimeTopic[] = [
  'work-items',
  'shared',
  'shared-metadata',
  'shared-messages',
  'discovery',
  'runtime',
  'insights',
  'artifacts',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRealtimeClientFrame(value: unknown): RealtimeClientFrame | null {
  if (!isRecord(value) || value.protocol !== REALTIME_PROTOCOL_VERSION || typeof value.type !== 'string') return null;
  if (value.type === 'hello') {
    return typeof value.clientId === 'string' && value.clientId.length > 0 && value.clientId.length <= 128
      && (value.resumeFrom === null || typeof value.resumeFrom === 'number' && Number.isSafeInteger(value.resumeFrom) && value.resumeFrom >= 0)
      ? value as RealtimeClientFrame
      : null;
  }
  if (value.type === 'cancel') {
    return typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128 ? value as RealtimeClientFrame : null;
  }
  if (value.type === 'request') {
    return typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128
      && typeof value.operation === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(value.operation)
      && (value.mode === 'read' || value.mode === 'command')
      ? value as RealtimeClientFrame
      : null;
  }
  return null;
}

export function parseRealtimeServerFrame(value: unknown): RealtimeServerFrame | null {
  if (!isRecord(value) || value.protocol !== REALTIME_PROTOCOL_VERSION || typeof value.type !== 'string') return null;
  if (value.type === 'ready') {
    return typeof value.sessionId === 'string' && typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence)
      && value.sequence >= 0 && typeof value.resumed === 'boolean' ? value as RealtimeServerFrame : null;
  }
  if (value.type === 'response' || value.type === 'progress') return typeof value.id === 'string' ? value as RealtimeServerFrame : null;
  if (value.type === 'error') {
    return (value.id === null || typeof value.id === 'string') && typeof value.code === 'string'
      && typeof value.message === 'string' && typeof value.retryable === 'boolean' ? value as RealtimeServerFrame : null;
  }
  if (value.type !== 'event' || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !isRecord(value.event)) return null;
  const event = value.event;
  if (event.kind === 'invalidate') {
    if (!Array.isArray(event.topics) || !event.topics.every((topic) => typeof topic === 'string' && realtimeTopics.includes(topic as RealtimeTopic))) return null;
    if (event.conversationId !== undefined && typeof event.conversationId !== 'string') return null;
    if (event.workItemId !== undefined && typeof event.workItemId !== 'string') return null;
  } else if (event.kind === 'notification') {
    if (!['success', 'error', 'info'].includes(String(event.tone)) || typeof event.message !== 'string') return null;
  } else if (event.kind === 'diff-confidence') {
    if (!isRecord(event.assessments)) return null;
  } else if (event.kind === 'review-score') {
    if (typeof event.decisionId !== 'string' || typeof event.revision !== 'string' || typeof event.completed !== 'number' || typeof event.total !== 'number') return null;
  } else return null;
  return value as RealtimeServerFrame;
}
