import { CACHE_READ_SOFT_LIMIT_TOKENS, type SharedMessage } from '../../../shared/contracts';
import { compactTokenCount } from '../../lib/formatters';

export function conversationCacheSpendWarning(messages: SharedMessage[]): string | null {
  const cacheReadTokens = messages.reduce((total, message) => total + (message.cacheReadInputTokens ?? 0), 0);
  if (cacheReadTokens < CACHE_READ_SOFT_LIMIT_TOKENS) return null;
  return `High cache traffic: ${compactTokenCount(cacheReadTokens)} cached tokens recorded in this conversation. Active agents keep running; later turns start from Workbench's compact context when provider-session reuse grows costly.`;
}
