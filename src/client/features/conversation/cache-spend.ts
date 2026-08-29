import { CACHE_READ_SOFT_LIMIT_TOKENS, type SharedMessage } from '../../../shared/contracts';
import { compactTokenCount } from '../../lib/formatters';

export function conversationCacheSpendWarning(messages: SharedMessage[]): string | null {
  const cacheReadTokens = messages.reduce((total, message) => total + (message.cacheReadInputTokens ?? 0), 0);
  if (cacheReadTokens < CACHE_READ_SOFT_LIMIT_TOKENS) return null;
  return `Cumulative cache spend: ${compactTokenCount(cacheReadTokens)} cached-input tokens recorded in this conversation. This is historical usage, not the current context size; active runs are forcibly bounded and continue once from a compact checkpoint.`;
}
