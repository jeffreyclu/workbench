import { MutationObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchQueryClient } from './query-client';

describe('createWorkbenchQueryClient', () => {
  it('refetches tab counts after a mutation succeeds or fails', async () => {
    const client = createWorkbenchQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await new MutationObserver(client, { mutationFn: async () => 'archived' }).mutate();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tab-counts'] });

    invalidate.mockClear();
    await new MutationObserver(client, { mutationFn: async () => { throw new Error('rejected'); } }).mutate().catch(() => undefined);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tab-counts'] });
  });
});
