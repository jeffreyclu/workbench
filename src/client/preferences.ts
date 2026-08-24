import type { AgentRun } from '../shared/contracts';

/**
 * Per-conversation and per-task choices Jeffrey makes in the UI live in
 * localStorage so a reload keeps the model he picked and the reply he was
 * halfway through typing.
 */
const conversationModelStorageKey = 'workbench:conversation-model-profiles';
const taskModelStorageKey = 'workbench:task-model-profiles';
const conversationDraftStorageKey = 'workbench:conversation-drafts';
const lastOpenedItemStorageKeys = {
  conversation: 'workbench:last-opened-conversation',
  attention: 'workbench:last-opened-attention-item',
  workbench: 'workbench:last-opened-workbench-item',
} as const;

/**
 * Primary surfaces deliberately keep separate return points. Opening a task
 * in Workbench must not replace the task we return to in Attention, and vice
 * versa.
 */
export type LastOpenedSurface = keyof typeof lastOpenedItemStorageKeys;

export function readLastOpenedItem(surface: LastOpenedSurface): string | null {
  try {
    const value = window.localStorage.getItem(lastOpenedItemStorageKeys[surface]);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

export function writeLastOpenedItem(surface: LastOpenedSurface, itemId: string): void {
  try {
    window.localStorage.setItem(lastOpenedItemStorageKeys[surface], itemId);
  } catch {
    // Storage can be disabled in a private browser context. Navigation still
    // works; it just cannot survive a later visit.
  }
}

/** Drop a remembered item once it no longer belongs to that primary surface. */
export function clearLastOpenedItem(surface: LastOpenedSurface): void {
  try {
    window.localStorage.removeItem(lastOpenedItemStorageKeys[surface]);
  } catch {
    // Storage can be disabled in a private browser context.
  }
}
export function readTaskModelProfiles(): Record<string, NonNullable<AgentRun['executionProfile']>> {
  try {
    const value = JSON.parse(window.localStorage.getItem(taskModelStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, NonNullable<AgentRun['executionProfile']>] => ['economy', 'standard', 'deep'].includes(String(entry[1]))));
  } catch {
    return {};
  }
}

export function writeTaskModelProfile(taskId: string, profile: AgentRun['executionProfile']): void {
  const profiles = readTaskModelProfiles();
  if (profile) profiles[taskId] = profile;
  else delete profiles[taskId];
  window.localStorage.setItem(taskModelStorageKey, JSON.stringify(profiles));
}

export function readConversationDrafts(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(conversationDraftStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

export function writeConversationDraft(conversationId: string, body: string): void {
  const drafts = readConversationDrafts();
  if (body) drafts[conversationId] = body;
  else delete drafts[conversationId];
  window.localStorage.setItem(conversationDraftStorageKey, JSON.stringify(drafts));
}

export function clearSentConversationDraft(conversationId: string, sentBody: string): void {
  const drafts = readConversationDrafts();
  if ((drafts[conversationId] ?? '') !== sentBody) return;
  delete drafts[conversationId];
  window.localStorage.setItem(conversationDraftStorageKey, JSON.stringify(drafts));
}

export function readConversationModelProfiles(): Record<string, NonNullable<AgentRun['executionProfile']>> {
  try {
    const value = JSON.parse(window.localStorage.getItem(conversationModelStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, NonNullable<AgentRun['executionProfile']>] => ['economy', 'standard', 'deep'].includes(String(entry[1]))));
  } catch {
    return {};
  }
}

export function writeConversationModelProfiles(profiles: Record<string, NonNullable<AgentRun['executionProfile']>>): void {
  window.localStorage.setItem(conversationModelStorageKey, JSON.stringify(profiles));
}
