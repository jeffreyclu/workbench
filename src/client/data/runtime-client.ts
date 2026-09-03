import type { MemorySearchResponse, ProjectSummary } from '../../shared/contracts';
import type { AiProviderAvailability, AiProviderChoice } from '../../shared/ai-providers';
import { request } from './request';

export interface AgentAccountProfile {
  name: string;
  providers: Record<'codex' | 'claude', { configured: boolean; loggedIn: boolean; email: string | null; detail: string | null }>;
}

export const runtimeClient = {
  getHealth: () => request<{ ok: boolean; mode: string; runtimeWorkActive: boolean; buildId: string }>('/api/health'),
  getWorkItemCounts: () => request<{ active: number; workbench: number; archive: number; attentionArchive: number; workbenchArchive: number }>('/api/work-item-counts'),
  getProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  getRuntimePreviewStatus: () => request<{ pending: boolean; currentFingerprint: string; promotedFingerprint: string | null; promotedAt: string | null }>('/api/runtime/preview-status'),
  getPromotionQueueStatus: () => request<{
    queueLength: number;
    oldestQueuedAt: string | null;
    running: { conversationId: string | null; progress: string; startedAt: string } | null;
    lastBuild: { status: 'succeeded' | 'failed'; at: string; summary: string } | null;
  }>('/api/runtime/promotion-status'),
  /** Whether the surface asking can actually reach Palmyra, and the sentence
   * its selector shows when it cannot. */
  getAiProviderAvailability: (provider: AiProviderChoice, accountProfile?: string | null) => {
    const query = new URLSearchParams({ provider });
    if (accountProfile) query.set('accountProfile', accountProfile);
    return request<AiProviderAvailability>(`/api/ai/providers?${query.toString()}`);
  },
  listAgentAccounts: () => request<{ accounts: AgentAccountProfile[] }>('/api/agent-accounts'),
  startAgentAccountLogin: (provider: 'codex' | 'claude', name: string) => request<{ accounts: AgentAccountProfile[] }>('/api/agent-accounts/login', { method: 'POST', body: JSON.stringify({ provider, name }) }),
  searchMemory: (query: string, limit?: number) => {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set('limit', String(limit));
    return request<MemorySearchResponse>(`/api/memory/search?${params}`);
  },
};
