import { describe, expect, it } from 'vitest';
import { realtimeTopicsForMutation } from './request-audit.js';

describe('request mutation realtime topics', () => {
  it('treats mark-read as metadata-only so opening a conversation cannot reload its body', () => {
    expect(realtimeTopicsForMutation('/api/shared/conversations/00000000-0000-4000-8000-000000000001/read'))
      .toEqual(['shared-metadata']);
  });

  it('keeps actual shared mutations on the broad shared invalidation path', () => {
    expect(realtimeTopicsForMutation('/api/shared/messages')).toEqual(['shared', 'work-items', 'insights']);
  });
});
