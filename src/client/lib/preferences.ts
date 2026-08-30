import type { AgentRun } from '../../shared/contracts';

/**
 * Per-conversation and per-task choices Jeffrey makes in the UI live in
 * localStorage so a reload keeps the model he picked and the reply he was
 * halfway through typing.
 */
const conversationModelStorageKey = 'workbench:conversation-model-profiles';
const taskModelStorageKey = 'workbench:task-model-profiles';
const conversationDraftStorageKey = 'workbench:conversation-drafts';
const workspaceDiffSelectionsStorageKey = 'workbench:workspace-diff-selections';
/** The Review surface remembers its own source and its own block, under its
 * own key. Sharing Changes' key would mean opening Review moves the file
 * Changes is showing — the one thing the review stack is not allowed to do. */
const reviewStackSelectionsStorageKey = 'workbench:review-stack-selections';
/** Reading mode is a habit, not a selection: it is remembered once for the
 * reviewer rather than per conversation, so moving between reviews does not
 * silently put the code pane back into interleaved diff. */
const reviewStackReadingModeStorageKey = 'workbench:review-stack-reading-mode';
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

type WorkspaceDiffSelections = Record<string, { source: string; decisions: Record<string, string> }>;

function readWorkspaceDiffSelections(): WorkspaceDiffSelections {
  try {
    const value = JSON.parse(window.localStorage.getItem(workspaceDiffSelectionsStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).flatMap(([scope, selection]) => {
      if (!selection || typeof selection !== 'object') return [];
      const { source, decisions } = selection as Record<string, unknown>;
      if (typeof source !== 'string' || !source) return [];
      const validDecisions = decisions && typeof decisions === 'object'
        ? Object.fromEntries(Object.entries(decisions).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])))
        : {};
      return [[scope, { source, decisions: validDecisions }]];
    }));
  } catch {
    return {};
  }
}

export function readWorkspaceDiffSelection(scope: string): { source: string; decisions: Record<string, string> } | null {
  return readWorkspaceDiffSelections()[scope] ?? null;
}

export function writeWorkspaceDiffSource(scope: string, source: string): void {
  try {
    const selections = readWorkspaceDiffSelections();
    selections[scope] = { source, decisions: selections[scope]?.decisions ?? {} };
    window.localStorage.setItem(workspaceDiffSelectionsStorageKey, JSON.stringify(selections));
  } catch {
    // Review navigation remains usable when browser storage is unavailable.
  }
}

export function writeWorkspaceDiffDecision(scope: string, revision: string, decisionId: string): void {
  try {
    const selections = readWorkspaceDiffSelections();
    const selection = selections[scope];
    if (!selection) return;
    selection.decisions[revision] = decisionId;
    window.localStorage.setItem(workspaceDiffSelectionsStorageKey, JSON.stringify(selections));
  } catch {
    // A decision can still be reviewed even if its browser preference cannot save.
  }
}


type ReviewStackSelections = Record<string, { source: string; blocks: Record<string, string> }>;

function readReviewStackSelections(): ReviewStackSelections {
  try {
    const value = JSON.parse(window.localStorage.getItem(reviewStackSelectionsStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).flatMap(([scope, selection]) => {
      if (!selection || typeof selection !== 'object') return [];
      const { source, blocks } = selection as Record<string, unknown>;
      if (typeof source !== 'string' || !source) return [];
      const validBlocks = blocks && typeof blocks === 'object'
        ? Object.fromEntries(Object.entries(blocks).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])))
        : {};
      return [[scope, { source, blocks: validBlocks }]];
    }));
  } catch {
    return {};
  }
}

export function readReviewStackSelection(scope: string): { source: string; blocks: Record<string, string> } | null {
  return readReviewStackSelections()[scope] ?? null;
}

export function writeReviewStackSource(scope: string, source: string): void {
  try {
    const selections = readReviewStackSelections();
    selections[scope] = { source, blocks: selections[scope]?.blocks ?? {} };
    window.localStorage.setItem(reviewStackSelectionsStorageKey, JSON.stringify(selections));
  } catch {
    // The queue stays usable when browser storage is unavailable.
  }
}

/** The diff pane's `DiffReadingMode`, plus Review's own whole-file reading.
 * Declared here so preference storage does not depend on a feature component. */
export type ReviewStackReadingMode = 'diff' | 'final' | 'file';

export function readReviewStackReadingMode(): ReviewStackReadingMode | null {
  try {
    const value = window.localStorage.getItem(reviewStackReadingModeStorageKey);
    return value === 'diff' || value === 'final' || value === 'file' ? value : null;
  } catch {
    return null;
  }
}

export function writeReviewStackReadingMode(mode: ReviewStackReadingMode): void {
  try {
    window.localStorage.setItem(reviewStackReadingModeStorageKey, mode);
  } catch {
    // The mode still applies to this session even if it cannot be remembered.
  }
}

export function writeReviewStackBlock(scope: string, revision: string, blockId: string): void {
  try {
    const selections = readReviewStackSelections();
    const selection = selections[scope];
    if (!selection) return;
    selection.blocks[revision] = blockId;
    window.localStorage.setItem(reviewStackSelectionsStorageKey, JSON.stringify(selections));
  } catch {
    // A block can still be judged even if its browser preference cannot save.
  }
}
