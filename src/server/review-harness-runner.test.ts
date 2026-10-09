import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReviewHarness, type ReviewHarness } from '../shared/review-harness.js';
import { adversarialLensAgent, runAdversarialLens } from './review-harness-runner.js';

const ATTACK = '<adversarial-ledger>{"version":1,"attacks":[{"targetClaim":"c","method":"m","result":"escaped","evidence":"a.ts:1"}]}</adversarial-ledger>';

describe('runAdversarialLens', () => {
  let directory: string | undefined;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

  function repo(): { cwd: string; harness: ReviewHarness } {
    directory = mkdtempSync(join(tmpdir(), 'adversarial-lens-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(directory, 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const harness = buildReviewHarness({
      source: { kind: 'workspace', workspacePath: directory }, revision: 'r1', reviews: [],
      files: [{ path: 'a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n' }],
    });
    return { cwd: directory, harness };
  }

  it('uses Codex for automatic failure-mode review', () => {
    expect([adversarialLensAgent('claude'), adversarialLensAgent('codex'), adversarialLensAgent('palmyra')]).toEqual(['codex', 'codex', 'codex']);
  });

  it('attacks from a read-only checkout at the merge base and removes it afterwards', async () => {
    const { cwd, harness } = repo();
    const seen: { cwd: string; prompt: string; readOnly: boolean; content: string } = { cwd: '', prompt: '', readOnly: false, content: '' };
    const lens = await runAdversarialLens({
      agent: 'codex', harness, cwd, requirement: 'Keep a at 1.', acceptanceCriteria: ['a is 1'],
      runAgent: async (_agent, lensCwd, prompt) => {
        seen.cwd = lensCwd; seen.prompt = prompt;
        seen.content = execFileSync('cat', [join(lensCwd, 'a.ts')]).toString();
        try { writeFileSync(join(lensCwd, 'a.ts'), 'tampered'); } catch { seen.readOnly = true; }
        return `Attacked.\n${ATTACK}`;
      },
    });
    expect(seen.content).toBe('export const a = 1;\n');
    expect(seen.readOnly).toBe(true);
    expect(seen.prompt).toContain('Keep a at 1.');
    expect(seen.prompt).not.toContain('review-ledger');
    expect(lens.error).toBeNull();
    expect(lens.ledger?.attacks[0].result).toBe('escaped');
    expect(lens.summary).toBe('Attacked.');
    expect(lens.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(seen.cwd)).toBe(false);
  });

  it('records a failure instead of throwing', async () => {
    const { cwd, harness } = repo();
    const lens = await runAdversarialLens({ agent: 'claude', harness, cwd, requirement: '', acceptanceCriteria: [], runAgent: async () => { throw new Error('vendor down'); } });
    expect(lens.ledger).toBeNull();
    expect(lens.error).toBe('vendor down');
  });

  it('records an invalid ledger as the error', async () => {
    const { cwd, harness } = repo();
    const lens = await runAdversarialLens({ agent: 'claude', harness, cwd, requirement: '', acceptanceCriteria: [], runAgent: async () => 'no block' });
    expect(lens.error).toMatch(/no <adversarial-ledger>/);
  });
});
