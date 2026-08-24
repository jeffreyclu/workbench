import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { scanClaudeLocalUsage, scanCodexLocalUsage } from './local-usage.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function root() { const value = mkdtempSync(join(tmpdir(), 'workbench-local-usage-')); roots.push(value); return value; }

describe('local usage scans', () => {
  it('keeps Claude fresh, cache write, cache read, and output separate', () => {
    const directory = root();
    writeFileSync(join(directory, 'session.jsonl'), JSON.stringify({ timestamp: '2026-08-24T12:00:00.000Z', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } } }) + '\n');
    expect(scanClaudeLocalUsage(new Date('2026-08-24T00:00:00.000Z'), new Date('2026-08-25T00:00:00.000Z'), directory)).toMatchObject({ freshInputTokens: 10, cacheWriteInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40, totalTrafficTokens: 100, samples: 1 });
  });
  it('subtracts Codex cache reads from inclusive input before totaling traffic', () => {
    const directory = root(); const nested = join(directory, '2026', '08'); mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'session.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: '2026-08-24T12:00:00.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 5 } } } }) + '\n');
    expect(scanCodexLocalUsage(new Date('2026-08-24T00:00:00.000Z'), new Date('2026-08-25T00:00:00.000Z'), directory)).toMatchObject({ freshInputTokens: 10, cacheWriteInputTokens: null, cacheReadInputTokens: 90, outputTokens: 5, totalTrafficTokens: 105, samples: 1 });
  });
});
