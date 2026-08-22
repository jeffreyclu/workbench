import { describe, expect, it } from 'vitest';
import { rejectPreviewMutation } from './app.js';
import { previewRuntimeCapabilities } from './runtime-capabilities.js';

describe('preview runtime isolation', () => {
  it('allows interactive preview mutations and agent execution without owning background work or promotion', () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect(rejectPreviewMutation(method, previewRuntimeCapabilities)).toBeNull();
    }
    expect(rejectPreviewMutation('GET', previewRuntimeCapabilities)).toBeNull();
    expect(previewRuntimeCapabilities).toMatchObject({ allowMutations: true, runDiscoveryCatchUp: false, ownScheduler: false, promoteRuntime: false, executeAgents: true });
  });

});
