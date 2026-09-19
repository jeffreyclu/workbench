import { describe, expect, it } from 'vitest';
import { buildEvalCommand } from '../../scripts/mcpjam-evals.js';

describe('MCPJam behavioral eval runner', () => {
  it('defaults to offline validation without a one-run approval', () => {
    expect(buildEvalCommand([], {})).toEqual(expect.arrayContaining(['cloud', 'eval', 'validate']));
  });

  it('requires an explicit project and model for an approved live run', () => {
    expect(() => buildEvalCommand(['--approve-live-model-run'], {})).toThrow('MCPJAM_PROJECT');
    expect(() => buildEvalCommand(['--approve-live-model-run'], { MCPJAM_PROJECT: 'workbench' })).toThrow('MCPJAM_MODEL');
  });

  it('pins one iteration and a perfect pass threshold for a live run', () => {
    const command = buildEvalCommand(['--approve-live-model-run'], { MCPJAM_PROJECT: 'workbench', MCPJAM_MODEL: 'anthropic/claude-sonnet-4-6' });
    expect(command).toEqual(expect.arrayContaining(['run', '--iterations', '1', '--min-pass-rate', '100']));
  });
});
