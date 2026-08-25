/**
 * Single source of truth for promotion-queued copy. Used both by the durable
 * chat message (repository/conversation-router) and the live progress line
 * (orchestrator) so the two surfaces never drift out of sync.
 */
export const PROMOTION_QUEUED_MESSAGE =
  'Promotion queued. It will build once active agent work reaches a durable terminal state.';
