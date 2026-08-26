import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { PROMOTION_QUEUED_MESSAGE } from './promotion-messages.js';
import { WorkItemRepository } from './repository.js';

type PromoteRuntime = (signal: AbortSignal, onProgress: (body: string) => void) => Promise<string>;
const promoteRuntimeMock = vi.fn<PromoteRuntime>(async () => 'Preview approved and promoted.');
vi.mock('./runtime-promotion.js', () => ({
  promoteRuntime: (signal: AbortSignal, onProgress: (body: string) => void) => promoteRuntimeMock(signal, onProgress),
}));

const { startRuntimePromotionWorker } = await import('./runtime-promotion-worker.js');

describe('runtime promotion worker', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    promoteRuntimeMock.mockClear();
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  it('claims an approved promotion immediately, then waits for active work before building', async () => {
    const conversation = repository.createConversation('Promotion');
    const item = repository.create({ title: 'Active work', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    const promotion = repository.createSharedMessage('system', 'Promotion queued.', 'queued', conversation.id, [], 'promotion');
    const worker = startRuntimePromotionWorker(repository);

    await vi.advanceTimersByTimeAsync(0);
    expect(repository.getSharedMessageById(promotion.id)).toEqual(expect.objectContaining({
      status: 'running',
      body: PROMOTION_QUEUED_MESSAGE,
    }));
    expect(promoteRuntimeMock).not.toHaveBeenCalled();

    repository.updateRun(run.id, { status: 'completed' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(promoteRuntimeMock).toHaveBeenCalledOnce();
    expect(repository.getSharedMessageById(promotion.id)?.status).toBe('completed');
    worker.stop();
  });
});
