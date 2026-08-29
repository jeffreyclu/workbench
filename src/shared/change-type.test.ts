import { describe, expect, it } from 'vitest';
import { classifyChangeType, type ChangeTypeHunk } from './change-type.js';

function hunk(filePath: string, lines: string[], fileStatus: ChangeTypeHunk['fileStatus'] = 'modified'): ChangeTypeHunk {
  return { filePath, fileStatus, lines };
}

describe('classifyChangeType', () => {
  it('reads a new file as new code rather than as a generic edit', () => {
    const result = classifyChangeType([hunk('src/retry.ts', [
      '+export function retry(times: number) {',
      '+  if (times < 1) throw new Error("times must be positive");',
      '+  return times;',
      '+}',
    ], 'added')]);
    expect(result).toEqual({ primary: 'new_code', secondary: [] });
  });

  it('marks a change that ships its own tests, because coverage is then visible to the reviewer', () => {
    const result = classifyChangeType([
      hunk('src/retry.ts', ['+export function retry(times: number) {', '+  return times;', '+}'], 'added'),
      hunk('src/retry.test.ts', ["+it('returns the count', () => expect(retry(2)).toBe(2));"], 'added'),
    ]);
    expect(result.primary).toBe('new_code');
    expect(result.secondary).toContain('test_only');
  });

  it('reads a hunk that only removes lines as a deletion', () => {
    const result = classifyChangeType([hunk('src/legacy.ts', [
      '-export function legacyParse(input: string) {',
      '-  return input.trim();',
      '-}',
    ])]);
    expect(result.primary).toBe('deletion');
  });

  it('reads a removed file as a deletion even when the patch is unreadable', () => {
    expect(classifyChangeType([hunk('src/legacy.ts', [], 'removed')]).primary).toBe('deletion');
  });

  it('reads a re-declared symbol as a replacement, not as new code', () => {
    const result = classifyChangeType([hunk('src/parse.ts', [
      '-export function parse(input: string) {',
      '-  return input.split(",");',
      '-}',
      '+export function parse(input: string) {',
      '+  return input.split(",").map((part) => part.trim()).filter(Boolean);',
      '+}',
    ])]);
    expect(result.primary).toBe('replacement');
  });

  it('flags the declaration a replacement quietly drops, so a rewrite cannot launder a deletion', () => {
    const result = classifyChangeType([hunk('src/parse.ts', [
      '-export function parse(input: string) {',
      '-  return normalize(input).trim();',
      '-}',
      '-function normalize(value: string) {',
      '-  return value.toLowerCase();',
      '-}',
      '+export function parse(input: string) {',
      '+  return input.toLowerCase().trim();',
      '+}',
    ])]);
    expect(result.primary).toBe('replacement');
    expect(result.secondary).toContain('deletion');
  });

  it('reads a rewrite of the same lines as a refactor, and does not invent a deletion for a renamed local', () => {
    const result = classifyChangeType([hunk('src/total.ts', [
      '-  const total = items.reduce((sum, item) => sum + item.value, 0);',
      '-  return total;',
      '+  const subtotal = items.reduce((sum, item) => sum + item.value, 0);',
      '+  return subtotal;',
    ])]);
    expect(result).toEqual({ primary: 'refactor_pure', secondary: [] });
  });

  it('reads code that leaves one file and arrives in another as a move', () => {
    const moved = ['export function formatBytes(value: number) {', '  return `${Math.round(value / 1024)} KB`;', '}'];
    const result = classifyChangeType([
      hunk('src/util.ts', moved.map((line) => `-${line}`)),
      hunk('src/format.ts', moved.map((line) => `+${line}`)),
    ]);
    expect(result.primary).toBe('move_rename');
  });

  it('reads added branches with no removed declaration as an extension', () => {
    const result = classifyChangeType([hunk('src/handler.ts', [
      '-  return null;',
      "+  if (kind === 'retry') return retryHandler;",
      "+  if (kind === 'backoff') return backoffHandler;",
      "+  if (kind === 'jitter') return jitterHandler;",
      "+  if (kind === 'cap') return capHandler;",
      '+  return null;',
    ])]);
    expect(result.primary).toBe('extension');
  });

  it('falls back to a behavior edit when a condition is rewritten in place', () => {
    const result = classifyChangeType([hunk('src/access.ts', [
      "-  if (user.role === 'admin') return true;",
      "+  if (user.role === 'admin' && !user.suspended && featureEnabled('strict')) return true;",
      '+  logAccess(user);',
    ])]);
    expect(result.primary).toBe('behavior_edit');
  });

  it('classifies by path before reading a single line, so a lockfile is never scored as logic', () => {
    expect(classifyChangeType([hunk('pnpm-lock.yaml', ['+  resolution: {integrity: sha512-abc}'])]).primary).toBe('generated');
    expect(classifyChangeType([hunk('docs/product-model.md', ['+A new paragraph.'])]).primary).toBe('docs_comment');
    expect(classifyChangeType([hunk('package.json', ['+    "vitest": "^3.2.4",'])]).primary).toBe('config_dep');
    expect(classifyChangeType([hunk('src/retry.test.ts', ['+expect(retry(2)).toBe(2);'])]).primary).toBe('test_only');
  });

  it('reads a comment-only edit to production source as documentation', () => {
    const result = classifyChangeType([hunk('src/retry.ts', [
      '-// Retries three times.',
      '+// Retries three times, then gives up and surfaces the original error.',
    ])]);
    expect(result.primary).toBe('docs_comment');
  });

  it('returns the residual type for an empty decision instead of throwing', () => {
    expect(classifyChangeType([])).toEqual({ primary: 'behavior_edit', secondary: [] });
  });
});
