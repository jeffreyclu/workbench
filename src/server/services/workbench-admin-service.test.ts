import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from '../database.js';
import { WorkItemRepository } from '../repository.js';
import { ArtifactLibrary } from '../artifact-library.js';
import { liveRuntimeCapabilities } from '../runtime-capabilities.js';
import { ArtifactService } from './artifact-service.js';
import { WorkbenchAdminService } from './workbench-admin-service.js';

describe('WorkbenchAdminService.dispatchConversationTurn', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;
  let admin: WorkbenchAdminService;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    const artifacts = new ArtifactLibrary(database);
    admin = new WorkbenchAdminService(repository, liveRuntimeCapabilities, new ArtifactService(repository, artifacts));
  });

  afterEach(() => {
    database.close();
  });

  it('unpins a pinned conversation and its linked task when a turn is dispatched over MCP', () => {
    const task = repository.create({ title: 'Pinned MCP dispatch target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { status: 'pinned' });
    const conversation = repository.createConversation('Keep working', task.id);
    repository.setConversationPinned(conversation.id, true);

    admin.mcpActions().dispatchConversationTurn(conversation.id, 'jeffrey', 'testing', 'claude', undefined);

    expect(repository.getConversation(conversation.id)?.pinned).toBe(false);
    expect(repository.get(task.id)?.status).not.toBe('pinned');
  });

  it('does not unpin when the turn is not dispatched to an agent', () => {
    const task = repository.create({ title: 'Pinned no-op dispatch target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(task.id, { status: 'pinned' });
    const conversation = repository.createConversation('Stay pinned', task.id);
    repository.setConversationPinned(conversation.id, true);

    admin.mcpActions().dispatchConversationTurn(conversation.id, 'jeffrey', 'note only', 'none', undefined);

    expect(repository.getConversation(conversation.id)?.pinned).toBe(true);
    expect(repository.get(task.id)?.status).toBe('pinned');
  });
});
