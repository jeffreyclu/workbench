import type { ArtifactComment, ArtifactDetail, ArtifactSummary, PublishedArtifact } from '../../shared/contracts';
import { request } from './request';

export const artifactClient = {
  publishArtifact: (input: { path: string; title?: string; conversationId?: string; workItemId?: string }) => request<{ artifact: PublishedArtifact }>('/api/artifacts/publish', { method: 'POST', body: JSON.stringify(input) }),
  revokeArtifact: (id: string) => request<{ artifact: ArtifactSummary }>(`/api/artifacts/${id}`, { method: 'DELETE' }),
  listArtifacts: (view: 'published' | 'revoked' | 'all' = 'published') => request<{ artifacts: ArtifactSummary[]; counts: { published: number; revoked: number; openComments: number } }>(`/api/artifacts?view=${view}`),
  getArtifact: (id: string) => request<ArtifactDetail>(`/api/artifacts/${id}`),
  republishArtifact: (id: string) => request<{ artifact: ArtifactSummary; published: boolean; kind: string }>(`/api/artifacts/${id}/republish`, { method: 'POST' }),
  updateArtifact: (id: string, input: { title?: string; workItemId?: string | null; conversationId?: string | null }) => request<{ artifact: ArtifactSummary }>(`/api/artifacts/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  addArtifactComment: (id: string, input: { author: string; body: string }) => request<{ comment: ArtifactComment }>(`/api/artifacts/${id}/comments`, { method: 'POST', body: JSON.stringify(input) }),
  resolveArtifactComment: (id: string, commentId: string, resolved: boolean) => request<{ comment: ArtifactComment }>(`/api/artifacts/${id}/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ resolved }) }),
};
